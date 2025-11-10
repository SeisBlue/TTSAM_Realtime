import gradio as gr
import numpy as np
import pandas as pd
import plotly.graph_objs as go
import torch
import xarray as xr
from huggingface_hub import hf_hub_download
from loguru import logger
from obspy import read
from obspy.signal.trigger import classic_sta_lta, trigger_onset
from scipy.signal import detrend, iirfilter, sosfilt, zpk2sos
from scipy.spatial import cKDTree

from ttsam_model import get_full_model

tree = None
vs30_table = None

try:
    logger.info("從 Hugging Face 載入 Vs30 資料...")
    vs30_file = hf_hub_download(
        repo_id="SeisBlue/TaiwanVs30", filename="Vs30ofTaiwan.nc",
        repo_type="dataset"
    )
    ds = xr.open_dataset(vs30_file)
    lat_flat = ds["lat"].values.flatten()
    lon_flat = ds["lon"].values.flatten()
    vs30_flat = ds["vs30"].values.flatten()

    vs30_table = pd.DataFrame(
        {"lat": lat_flat, "lon": lon_flat, "Vs30": vs30_flat})
    vs30_table = vs30_table.replace([np.inf, -np.inf], np.nan).dropna()
    tree = cKDTree(vs30_table[["lat", "lon"]])
    logger.info("Vs30 資料載入完成")
except Exception as e:
    logger.warning(f"Vs30 資料載入失敗: {e}")
    logger.warning("將使用預設 Vs30 值 (600 m/s)")

# 載入測站資訊（輸入測站，1000+ 個）
site_info_file = "station/site_info.csv"
site_info = None
try:
    logger.info(f"載入 {site_info_file}...")
    site_info = pd.read_csv(site_info_file)

    # 驗證 site_info.csv 必要欄位
    required_site_fields = ["Station", "Latitude", "Longitude", "Elevation"]
    missing_site_fields = [
        f for f in required_site_fields if f not in site_info.columns
    ]
    if missing_site_fields:
        logger.error(
            f"{site_info_file} 缺少必要欄位: {missing_site_fields}")
        raise ValueError(
            f"site_info.csv 缺少必要欄位: {missing_site_fields}")

    # 只保留唯一的測站（去除重複的分量）
    site_info = site_info.drop_duplicates(subset=["Station"]).reset_index(
        drop=True)
    logger.info(f"{site_info_file} 載入完成，共 {len(site_info)} 個測站")
except FileNotFoundError:
    logger.warning(f"{site_info_file} 找不到")
except Exception as e:
    logger.error(f"{site_info_file} 載入失敗: {e}")

# 載入目標測站
target_file = "station/eew_target.csv"
try:
    logger.info(f"載入 {target_file}...")
    target_df = pd.read_csv(target_file)

    # 驗證 eew_target.csv 必要欄位
    required_target_fields = ["station", "latitude", "longitude",
                              "elevation"]
    missing_target_fields = [
        f for f in required_target_fields if f not in target_df.columns
    ]
    if missing_target_fields:
        logger.error(f"{target_file} 缺少必要欄位: {missing_target_fields}")
        raise ValueError(
            f"eew_target.csv 缺少必要欄位: {missing_target_fields}")

    target_dict = target_df.to_dict(orient="records")
    logger.info(f"{target_file} 載入完成（共 {len(target_dict)} 個目標點）")
except FileNotFoundError:
    logger.error(f"{target_file} 找不到")
except Exception as e:
    logger.error(f"{target_file} 載入失敗: {e}")

# ============ 震央資訊管理 ============

earthquake_metadata = {}
event_json_path = "waveform/event.json"

# STA/LTA 計算結果快取（避免每次滑桿更新都重算）
# 結構: {event_name: {station_code: {"p_arrival_time": float, "cft": array}}}
sta_lta_cache = {}

try:
    import json

    with open(event_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if "events" not in data:
        logger.error(f"{event_json_path} 缺少 'events' 鍵")

    # 將事件列表轉換為以 event_name 為鍵的字典
    for event in data["events"]:
        event_name = event.get("event_name")
        if event_name:
            earthquake_metadata[event_name] = {
                "event_id": event.get("event_id"),
                "event_name": event.get("event_name"),
                "timestamp": event.get("timestamp"),
                "first_pick": event.get("first_pick"),
                "mseed_file": event.get("mseed_file"),
                "intensity_map_file": event.get("intensity_map_file"),
                "epicenter_lat": event.get("epicenter_lat"),
                "epicenter_lon": event.get("epicenter_lon"),
                "depth_km": event.get("depth_km"),
                "magnitude": event.get("magnitude"),
            }
            logger.info(
                f"載入事件: {event_name} | 震央: ({event.get('epicenter_lon')}, {event.get('epicenter_lat')})"
            )

    logger.info(f"地震事件元資料載入完成（共 {len(earthquake_metadata)} 個事件）")

except FileNotFoundError:
    logger.error(f"事件元資料檔案缺失: {event_json_path}")


except Exception as e:
    logger.error(f"讀取事件元資料時發生錯誤: {e}")

# 載入模型
model_path = hf_hub_download(
    repo_id="SeisBlue/TTSAM", filename="ttsam_trained_model_11.pt"
)
model = get_full_model(model_path)


# ============ 輔助函數 ============


def lowpass(data, freq=10, df=100, corners=4):
    fe = 0.5 * df
    f = freq / fe
    if f > 1:
        f = 1.0
    z, p, k = iirfilter(corners, f, btype="lowpass", ftype="butter", output="zpk")
    sos = zpk2sos(z, p, k)
    return sosfilt(sos, data)


def signal_processing(waveform):
    data = detrend(waveform, type="constant")
    data = lowpass(data, freq=10)
    return data


def detect_p_wave_sta_lta(trace, sta_len=0.1, lta_len=2, thr_on=1.5, thr_off=0.0001):
    """
    使用 STA/LTA 方法偵測 P 波到時

    Parameters:
    - trace: ObsPy Trace object
    - sta_len: 短時窗長度（秒）
    - lta_len: 長時窗長度（秒）
    - thr_on: 觸發門檻（設為 2.0 以平衡偵測率與誤報率）
    - thr_off: 解除門檻

    Returns:
    - p_arrival_time: P 波到時（秒），若未偵測到則返回 None
    - cft: Characteristic function (STA/LTA 值)

    Note:
    - spec: P 波偵測為測站選擇的前置條件，未偵測到 P 波的測站將被排除
    - 降級策略：門檻設為 2.0，在偵測率與誤報率之間取得平衡
    """
    try:
        sampling_rate = trace.stats.sampling_rate

        # 計算 STA/LTA characteristic function
        cft = classic_sta_lta(trace.data, int(sta_len * sampling_rate),
                              int(lta_len * sampling_rate))

        # 偵測觸發點
        triggers = trigger_onset(cft, thr_on, thr_off)

        if len(triggers) > 0:
            # 取第一個觸發點作為 P 波到時
            p_sample = triggers[0][0]
            p_arrival_time = p_sample / sampling_rate
            logger.debug(f"測站 {trace.stats.station} 偵測到 P 波於 {p_arrival_time:.2f} 秒")
            return p_arrival_time, cft
        else:
            logger.debug(f"測站 {trace.stats.station} 未偵測到 P 波")
            return None, cft

    except Exception as e:
        logger.warning(f"P 波偵測失敗: {e}")
        return None, None


def get_vs30(lat, lon, user_vs30=600):
    if tree is None or vs30_table is None:
        # 如果 Vs30 資料未載入，使用使用者輸入的值
        logger.info(f"使用使用者輸入的 Vs30 值 ({user_vs30} m/s) for ({lat}, {lon})")
        return float(user_vs30)
    distance, i = tree.query([float(lat), float(lon)])
    vs30 = vs30_table.iloc[i]["Vs30"]
    logger.info(f"從資料庫查詢到 Vs30 值 ({vs30} m/s) for ({lat}, {lon})")
    return float(vs30)


def calculate_intensity(pga, label=False):
    intensity_label = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"]
    pga_level = np.log10([1e-5, 0.008, 0.025, 0.080, 0.250, 0.80, 1.4, 2.5, 4.4, 8.0])

    pga_intensity = np.searchsorted(pga_level, pga) - 1
    intensity = pga_intensity

    if label:
        return intensity_label[intensity]
    else:
        return intensity


def convert_intensity(value):
    """轉換震度字串為數值以便排序和比較"""
    if isinstance(value, (int, float)):
        return float(value)
    if value.endswith("+"):
        return float(value[:-1]) + 0.25
    elif value.endswith("-"):
        return float(value[:-1]) - 0.25
    else:
        return float(value)


def generate_earthquake_alert_report(pga_list, target_names, event_name, duration):
    """
    生成地震預警文字報告（僅顯示 4 級以上警報）

    Parameters:
    - pga_list: PGA 預測值列表
    - target_names: 目標測站名稱列表
    - event_name: 地震事件名稱
    - duration: P 波後時間長度

    Returns:
    - 格式化的警報文字報告
    """
    # 收集各縣市的最高震度
    county_intensity = {}

    for i, target_name in enumerate(target_names):
        target = next((t for t in target_dict if t["station"] == target_name), None)
        if target and "county" in target:
            county = target["county"]
            intensity = calculate_intensity(pga_list[i])
            intensity_label = calculate_intensity(pga_list[i], label=True)

            # 只記錄 4 級以上
            if intensity >= 4:
                if county not in county_intensity:
                    county_intensity[county] = intensity_label
                else:
                    # 保留較高的震度
                    if convert_intensity(intensity_label) > convert_intensity(
                            county_intensity[county]):
                        county_intensity[county] = intensity_label

    # 生成報告
    report_lines = []

    if county_intensity:
        # 按震度排序（高到低）
        county_list = sorted(
            county_intensity.items(),
            key=lambda x: convert_intensity(x[1]),
            reverse=True
        )
        for county, intensity in county_list:
            report_lines.append(f"  {county}　預估震度 {intensity} 級")
    else:
        report_lines.append("【預測震度 ≥ 4 級地區】")
        report_lines.append("")
        report_lines.append("  無縣市達 4 級以上")

    return "\n".join(report_lines)


# ============ Gradio 介面函數 ============


def calculate_distance(lat1, lon1, lat2, lon2):
    """計算兩點間的距離（簡化的平面距離，單位：度）"""
    return np.sqrt((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2)


def select_nearest_stations(st, epicenter_lat, epicenter_lon, n_stations=25, event_name=None):
    """
    從 site_info（1000+ 個輸入測站）中選擇距離震央最近的 n 個測站
    並使用 STA/LTA 偵測 P 波到時，只保留成功偵測到 P 波的測站

    少於 25 站可用：UI 明示實際用站數並允許繼續

    STA/LTA 結果會快取到全域 sta_lta_cache，避免滑桿更新時重複計算
    """
    station_distances = {}  # 改用字典避免重複
    p_wave_detected_count = 0
    p_wave_failed_count = 0
    cache_hit_count = 0
    cache_miss_count = 0

    # 初始化此事件的 cache
    if event_name and event_name not in sta_lta_cache:
        sta_lta_cache[event_name] = {}
        logger.info(f"為事件 {event_name} 初始化 STA/LTA 快取")

    # 計算每個測站到震央的距離並偵測 P 波
    for tr in st:
        station_code = tr.stats.station

        # 如果這個測站已經處理過，跳過（避免重複計算不同分量）
        if station_code in station_distances:
            continue

        # 從 site_info 中查詢測站位置（處理缺漏欄位）
        try:
            station_data = site_info[site_info["Station"] == station_code]
            if len(station_data) == 0:
                continue

            # 驗證必要欄位存在
            required_fields = ["Latitude", "Longitude", "Elevation"]
            missing_fields = [
                f for f in required_fields if f not in station_data.columns
            ]
            if missing_fields:
                logger.warning(
                    f"測站 {station_code} 缺少必要欄位: {missing_fields}，跳過"
                )
                continue

            lat = station_data["Latitude"].values[0]
            lon = station_data["Longitude"].values[0]
            elev = station_data["Elevation"].values[0]

            # 偵測 P 波（使用 Z 分量）- 優先使用快取
            if event_name and event_name in sta_lta_cache and station_code in sta_lta_cache[event_name]:
                # 使用快取的 STA/LTA 結果
                cached_result = sta_lta_cache[event_name][station_code]
                p_arrival_time = cached_result["p_arrival_time"]
                cft = cached_result["cft"]
                cache_hit_count += 1
                logger.debug(f"測站 {station_code} 使用快取的 STA/LTA 結果")
            else:
                # 重新計算 STA/LTA
                z_trace = st.select(station=station_code, component="Z")
                if len(z_trace) == 0:
                    logger.debug(f"測站 {station_code} 無 Z 分量，跳過")
                    p_wave_failed_count += 1
                    continue

                p_arrival_time, cft = detect_p_wave_sta_lta(z_trace[0])
                cache_miss_count += 1

                # 快取 STA/LTA 結果
                if event_name:
                    sta_lta_cache[event_name][station_code] = {
                        "p_arrival_time": p_arrival_time,
                        "cft": cft
                    }
                    logger.debug(f"測站 {station_code} STA/LTA 結果已快取")

            # 只保留成功偵測到 P 波的測站
            if p_arrival_time is None:
                logger.debug(f"測站 {station_code} 未偵測到 P 波，跳過")
                p_wave_failed_count += 1
                continue

            distance = calculate_distance(epicenter_lat, epicenter_lon, lat, lon)
            station_distances[station_code] = {
                "station": station_code,
                "distance": distance,
                "latitude": lat,
                "longitude": lon,
                "elevation": elev,
                "p_arrival_time": p_arrival_time,  # 記錄 P 波到時
            }
            p_wave_detected_count += 1


        except Exception as e:
            logger.warning(f"測站 {station_code} 資訊查詢失敗: {e}")
            p_wave_failed_count += 1
            continue

    # 轉換為列表並按距離排序，選擇最近的 n 個
    station_list = list(station_distances.values())
    station_list.sort(key=lambda x: x["distance"])
    selected_stations = station_list[:n_stations]

    # 記錄實際可用的測站數（少於 25 站也允許繼續）
    actual_count = len(selected_stations)
    logger.info(
        f"P 波偵測結果: 成功 {p_wave_detected_count} 站, 失敗 {p_wave_failed_count} 站 | "
        f"STA/LTA 快取: 命中 {cache_hit_count} 次, 未命中 {cache_miss_count} 次"
    )

    if actual_count < n_stations:
        logger.warning(
            f"僅找到 {actual_count} 個可用測站（目標 {n_stations} 個），將繼續處理"
        )
    else:
        logger.info(
            f"從 {len(station_list)} 個輸入測站中選擇了最近的 {actual_count} 個"
        )

    return selected_stations


def extract_waveforms_from_stream(event_name,
                                  st, selected_stations, duration, vs30_input
                                  ):
    """
    從 Stream 中提取選定測站的波形資料

    Parameters:
    - st: ObsPy Stream object
    - selected_stations: 選定的測站列表
    - start_time: 開始時間（秒）
    - duration: 時間長度（秒）
    - vs30_input: Vs30 預設值

    Returns:
    - waveforms: 波形資料列表
    - station_info_list: 測站資訊列表
    - valid_stations: 有效測站列表
    - missing_components_count: 缺少分量的測站數量
    - p_wave_outside_window_count: P 波在時間窗外的測站數量

    Note:
    - 內部計算 end_time = start_time + duration
    - 若 duration < 30 秒，尾段以 0 遮罩補齊至 30 秒（3000 samples @ 100 Hz）
    - 缺少 N/E 分量時以 Z 分量代替，並在狀態訊息中記錄缺分量站數
    - 若 P 波到時不在時間窗內，跳過該測站（避免模型收到無訊號的空波形）
    """
    waveforms = []
    station_info_list = []
    valid_stations = []
    missing_components_count = 0
    p_wave_outside_window_count = 0

    sampling_rate = 100  # 100 Hz
    min_duration = 30.0  # 最小時間長度 30 秒
    target_length = 3000  # 30 秒 @ 100 Hz = 3000 samples
    first_pick = earthquake_metadata[event_name]["first_pick"]

    # 內部計算 end_time（接受 start/duration 參數）
    end_time = first_pick + duration

    start_idx = 0
    end_idx = int(end_time * sampling_rate)
    actual_samples = end_idx - start_idx

    logger.info(
        f"波形提取範圍：[{start_idx/sampling_rate:.2f}s, {end_idx/sampling_rate:.2f}s] "
        f"= {actual_samples} samples (first_pick={first_pick:.2f}s, duration={duration}s)"
    )

    # 檢查是否需要零填充：長度不足 30 秒時尾段以 0 遮罩補齊
    needs_padding = duration < min_duration
    if needs_padding:
        logger.info(
            f"時間長度 {duration} 秒 < 30 秒，將以 0 遮罩補齊至 {min_duration} 秒"
        )

    for station_data in selected_stations:
        # 檢查 P 波到時是否在時間窗內
        p_arrival_time = station_data.get("p_arrival_time")
        if p_arrival_time is None or p_arrival_time < 0 or p_arrival_time > end_time:
            logger.debug(
                f"測站 {station_data['station']} 的 P 波到時 ({p_arrival_time:.2f}s) 不在時間窗內 (0-{end_time:.2f}s)，跳過"
            )
            p_wave_outside_window_count += 1
            continue
        station_code = station_data["station"]
        station_missing_components = False

        try:
            # 選擇該測站的所有分量
            st_station = st.select(station=station_code)

            if len(st_station) == 0:
                continue

            # 嘗試取得 Z, N, E 分量
            z_trace = st_station.select(component="Z")
            n_trace = st_station.select(component="N") or st_station.select(
                component="1"
            )
            e_trace = st_station.select(component="E") or st_station.select(
                component="2"
            )

            # 檢查 Z 分量（必須存在）
            if len(z_trace) > 0:
                z_data = z_trace[0].data[start_idx:end_idx]
                logger.debug(f"測站 {station_code}: Z 分量切片長度 = {len(z_data)} samples")
            else:
                continue

            # 檢查 N 分量（缺失時以 Z 代替）
            if len(n_trace) > 0:
                n_data = n_trace[0].data[start_idx:end_idx]
            else:
                n_data = z_data.copy()
                station_missing_components = True
                logger.debug(f"測站 {station_code} 缺少 N 分量，以 Z 分量代替")

            # 檢查 E 分量（缺失時以 Z 代替）
            if len(e_trace) > 0:
                e_data = e_trace[0].data[start_idx:end_idx]
            else:
                e_data = z_data.copy()
                station_missing_components = True
                logger.debug(f"測站 {station_code} 缺少 E 分量，以 Z 分量代替")

            # 記錄缺少分量的測站（將在狀態訊息中顯示）
            if station_missing_components:
                missing_components_count += 1

            # 訊號處理
            z_data = signal_processing(z_data)
            n_data = signal_processing(n_data)
            e_data = signal_processing(e_data)

            # 創建全零陣列 (3000, 3) - 確保至少 30 秒長度
            # 不足 30 秒時，尾段以 0 遮罩補齊
            waveform_3c = np.zeros((target_length, 3))

            # 填入實際資料（處理長度不足或過長的情況）
            z_len = min(len(z_data), target_length)
            n_len = min(len(n_data), target_length)
            e_len = min(len(e_data), target_length)

            waveform_3c[:z_len, 0] = z_data[:z_len]
            waveform_3c[:n_len, 1] = n_data[:n_len]
            waveform_3c[:e_len, 2] = e_data[:e_len]

            waveforms.append(waveform_3c)

            # 準備測站資訊
            vs30 = get_vs30(
                station_data["latitude"], station_data["longitude"], vs30_input
            )
            station_info_list.append(
                [
                    station_data["latitude"],
                    station_data["longitude"],
                    station_data["elevation"],
                    vs30,
                ]
            )
            valid_stations.append(station_data)

        except Exception as e:
            logger.warning(f"測站 {station_code} 波形提取失敗: {e}")
            continue

    logger.info(f"成功提取 {len(waveforms)} 個測站的波形")
    if missing_components_count > 0:
        logger.info(
            f"其中 {missing_components_count} 個測站缺少 N 或 E 分量（已以 Z 分量代替）"
        )
    if p_wave_outside_window_count > 0:
        logger.info(
            f"其中 {p_wave_outside_window_count} 個測站的 P 波不在時間窗內（已跳過）"
        )

    return waveforms, station_info_list, valid_stations, missing_components_count, p_wave_outside_window_count


def plot_waveform(st, selected_stations, first_pick, duration):
    """
    繪製選定測站的波形圖（距離-時間圖，可顯示全部 25 個測站）
    並標記 P 波到時，用顏色區分是否在時間窗內

    Parameters:
    - st: ObsPy Stream object
    - selected_stations: 選定的測站列表（包含快取的 p_arrival_time，避免重複計算 STA/LTA）
    - first_pick: 首次到達時間（秒）
    - duration: 時間長度（秒）

    Note: P 波到時資訊來自快取，不會重新計算 STA/LTA（提升反應速度）
    """
    # 計算結束時間
    end_time = first_pick + duration

    logger.debug(f"繪製波形圖（使用快取的 P 波到時資訊，共 {len(selected_stations)} 個測站）")

    # 創建 Plotly figure
    fig = go.Figure()

    # 設定振幅縮放比例（避免波形重疊）
    amplitude_scale = 0.03  # 可調整此值來控制波形大小

    plotted_count = 0
    distances = []
    station_names = []
    p_wave_markers_in = []  # P 波在時間窗內
    p_wave_markers_out = []  # P 波在時間窗外

    # 效能優化：降採樣因子（在 HF Space 環境下加速渲染）
    downsample_factor = 5  # 只取每 5 個點（100 Hz → 20 Hz，仍足夠顯示波形特徵）

    for i, station_data in enumerate(selected_stations):
        station_code = station_data["station"]
        distance = station_data["distance"]
        p_arrival_time = station_data.get("p_arrival_time")

        try:
            st_station = st.select(station=station_code)
            if len(st_station) > 0:
                tr = st_station[0]
                times = tr.times()
                data = tr.data

                # 只顯示從資料開始到 120 秒內的波形
                time_mask = times <= 120.0
                times = times[time_mask]
                data = data[time_mask]

                # 效能優化：降採樣（減少數據點數量，加速渲染）
                times = times[::downsample_factor]
                data = data[::downsample_factor]

                # 正規化波形振幅
                data_normalized = data / (np.max(np.abs(data)) + 1e-10)

                # 繪製波形，Y軸位置為距離
                y_values = distance + data_normalized * amplitude_scale

                # 使用 Scattergl 加速渲染（WebGL 模式，適合大量數據點）
                fig.add_trace(go.Scattergl(
                    x=times,
                    y=y_values,
                    mode='lines',
                    line=dict(color='black', width=0.5),
                    opacity=0.8,
                    name=station_code,
                    hovertemplate=f'{station_code}<br>Time: %{{x:.2f}}s<br>Distance: {distance:.3f}°<extra></extra>',
                    showlegend=False
                ))

                # 記錄 P 波標記位置
                if p_arrival_time is not None:
                    if 0 <= p_arrival_time <= end_time:
                        # P 波在時間窗內（綠色）
                        p_wave_markers_in.append((p_arrival_time, distance, station_code))
                    else:
                        # P 波在時間窗外（紅色）
                        p_wave_markers_out.append((p_arrival_time, distance, station_code))

                distances.append(distance)
                station_names.append(station_code)
                plotted_count += 1

        except Exception as e:
            logger.warning(f"無法繪製測站 {station_code}: {e}")

    # 繪製 P 波標記
    if p_wave_markers_in:
        p_times_in, p_dists_in, p_names_in = zip(*p_wave_markers_in)
        fig.add_trace(go.Scattergl(
            x=p_times_in,
            y=p_dists_in,
            mode='markers',
            marker=dict(color='green', size=8, symbol='triangle-down'),
            name='P-wave (in window)',
            hovertemplate='P-wave<br>Station: %{text}<br>Time: %{x:.2f}s<extra></extra>',
            text=p_names_in,
            showlegend=True
        ))

    if p_wave_markers_out:
        p_times_out, p_dists_out, p_names_out = zip(*p_wave_markers_out)
        fig.add_trace(go.Scattergl(
            x=p_times_out,
            y=p_dists_out,
            mode='markers',
            marker=dict(color='red', size=8, symbol='triangle-down'),
            name='P-wave (out window)',
            hovertemplate='P-wave<br>Station: %{text}<br>Time: %{x:.2f}s<extra></extra>',
            text=p_names_out,
            showlegend=True
        ))

    # 添加垂直線標記
    # First Motion
    fig.add_vline(
        x=first_pick,
        line=dict(color='blue', dash='dash', width=2),
        annotation_text='First Motion',
        annotation_position='top',
        opacity=0.7
    )

    # 標記選取時間範圍
    fig.add_vline(
        x=0,
        line=dict(color='red', dash='dash', width=2),
        opacity=0.7
    )

    fig.add_vline(
        x=end_time,
        line=dict(color='red', dash='dash', width=2),
        opacity=0.7
    )

    # 添加時間窗陰影
    fig.add_vrect(
        x0=0, x1=end_time,
        fillcolor='blue', opacity=0.1,
        layer='below', line_width=0,
    )

    # 設定軸標籤和標題
    fig.update_layout(
        xaxis=dict(
            title=dict(text='Time (s)', font=dict(size=12)),
            gridcolor='rgba(128, 128, 128, 0.2)',
            showgrid=True,
        ),
        yaxis=dict(
            title=dict(text='Distance (°)', font=dict(size=12)),
            gridcolor='rgba(128, 128, 128, 0.2)',
            showgrid=False
        ),
        hovermode='closest',
        height=200,
        plot_bgcolor='white',
        margin=dict(l=0, r=10, t=50, b=0),  # 緊凑的邊距設置
        showlegend=True,
        legend=dict(
            yanchor="top",
            y=0.99,
            xanchor="right",
            x=0.99,
            bgcolor="rgba(255, 255, 255, 0.8)",
        ),
        # 效能優化：簡化互動功能以加速渲染（HF Space 環境）
        dragmode='pan',  # 只允許平移，不允許框選縮放
    )

    return fig


def get_intensity_color(intensity):
    """根據震度等級返回對應顏色（參考 intensityMap.html）"""
    color_map = {
        0: "#ffffff",  # 白色
        1: "#33FFDD",  # 青色
        2: "#34ff32",  # 綠色
        3: "#fefd32",  # 黃色
        4: "#fe8532",  # 橘色
        5: "#fd5233",  # 紅橘色 (5-)
        6: "#c43f3b",  # 深紅色 (5+)
        7: "#9d4646",  # 暗紅色 (6-)
        8: "#9a4c86",  # 紫紅色 (6+)
        9: "#b51fea",  # 紫色 (7)
    }
    return color_map.get(intensity, "#ffffff")


def create_intensity_map(
        pga_list, target_names, epicenter_lat=None, epicenter_lon=None,
        selected_stations=None, duration=None, first_pick=None
):
    """使用 Plotly 創建互動式震度分布地圖（合併輸入測站與預測震度）

    輸入測站的透明度根據 P 波到時是否在時間窗內調整：
    - P 波在時間窗內：較不透明 (opacity=0.9)
    - P 波在時間窗外：較透明 (opacity=0.3)
    """

    # 按震度等級分組資料
    intensity_groups = {
        i: {"lat": [], "lon": [], "text": [], "color": get_intensity_color(i)}
        for i in range(10)
    }

    # 添加震度測站標記
    all_lats = []
    all_lons = []
    for i, target_name in enumerate(target_names):
        target = next((t for t in target_dict if t["station"] == target_name), None)
        if target:
            lat = target["latitude"]
            lon = target["longitude"]
            all_lats.append(lat)
            all_lons.append(lon)
            intensity = calculate_intensity(pga_list[i])
            intensity_label = calculate_intensity(pga_list[i], label=True)
            pga = pga_list[i]

            hover_text = (
                f"{target_name}<br>"
                f"震度: {intensity_label}<br>"
                f"PGA: {pga:.4f} m/s²<br>"
                f"位置: ({lat:.3f}, {lon:.3f})"
            )

            intensity_groups[intensity]["lat"].append(lat)
            intensity_groups[intensity]["lon"].append(lon)
            intensity_groups[intensity]["text"].append(hover_text)

    # 地圖中心固定為台灣中心
    map_center_lat = 23.6
    map_center_lon = 121.0

    # 創建 Plotly 地圖
    fig = go.Figure()

    # 【底層】添加輸入測站（根據 P 波時間點是否在時間窗內調整透明度）
    if selected_stations:
        # 分離 P 波在時間窗內和時間窗外的測站
        stations_in_window = {"lat": [], "lon": [], "text": []}
        stations_out_window = {"lat": [], "lon": [], "text": []}

        # 計算時間窗範圍
        end_time = first_pick + duration if first_pick is not None and duration is not None else None

        for station_data in selected_stations:
            lat = station_data["latitude"]
            lon = station_data["longitude"]
            station_name = station_data["station"]
            p_arrival_time = station_data.get("p_arrival_time")

            # 判斷 P 波是否在時間窗內
            in_window = False
            if end_time is not None and p_arrival_time is not None:
                in_window = (0 <= p_arrival_time <= end_time)

            hover_text = (
                f"{station_name}<br>"
                f"輸入測站<br>"
                f"P 波到時: {p_arrival_time:.2f}s<br>" if p_arrival_time is not None else f"{station_name}<br>輸入測站<br>"
                f"位置: ({lat:.3f}, {lon:.3f})"
            )

            if in_window:
                stations_in_window["lat"].append(lat)
                stations_in_window["lon"].append(lon)
                stations_in_window["text"].append(hover_text)
            else:
                stations_out_window["lat"].append(lat)
                stations_out_window["lon"].append(lon)
                stations_out_window["text"].append(hover_text)

        # 添加時間窗內的測站（較不透明）
        if stations_in_window["lat"]:
            fig.add_trace(
                go.Scattermap(
                    lat=stations_in_window["lat"],
                    lon=stations_in_window["lon"],
                    mode="markers",
                    marker=dict(
                        size=8,
                        color="rgba(128, 128, 128, 0.9)",  # 較不透明
                    ),
                    text=stations_in_window["text"],
                    hoverinfo="text",
                    name="輸入測站 (P波在窗內)",
                    showlegend=True,
                )
            )

        # 添加時間窗外的測站（較透明）
        if stations_out_window["lat"]:
            fig.add_trace(
                go.Scattermap(
                    lat=stations_out_window["lat"],
                    lon=stations_out_window["lon"],
                    mode="markers",
                    marker=dict(
                        size=8,
                        color="rgba(128, 128, 128, 0.3)",  # 較透明
                    ),
                    text=stations_out_window["text"],
                    hoverinfo="text",
                    name="輸入測站 (P波在窗外)",
                    showlegend=True,
                )
            )

    # 【頂層】添加各震度等級的測站（預測結果）
    intensity_labels = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"]
    for intensity_level in range(10):
        group = intensity_groups[intensity_level]
        if group["lat"]:  # 有資料的震度等級
            # 先添加圓圈標記
            fig.add_trace(
                go.Scattermap(
                    lat=group["lat"],
                    lon=group["lon"],
                    mode="markers+text",
                    marker=dict(size=20, color=group["color"], opacity=0.9),
                    text=intensity_labels[intensity_level],
                    textposition="middle center",
                    textfont=dict(size=14,
                                  color=("black" if intensity_level <= 4 else "white"),
                                  family="Open Sans Bold"),
                    hoverinfo="text",
                    name=f"震度 {intensity_labels[intensity_level]}",
                    showlegend=True,
                )
            )
        else:
            # 沒有資料的震度等級：添加隱形標記只為了顯示圖例
            fig.add_trace(
                go.Scattermap(
                    lat=[None],
                    lon=[None],
                    mode="markers",
                    marker=dict(size=24, color=group["color"], opacity=0.9),
                    name=f"震度 {intensity_labels[intensity_level]}",
                    showlegend=True,
                    hoverinfo="skip",
                )
            )

    # 【中層】添加震央（紅色標記）
    if epicenter_lat is not None and epicenter_lon is not None:
        fig.add_trace(
            go.Scattermap(
                lat=[epicenter_lat],
                lon=[epicenter_lon],
                mode="markers",
                marker=dict(size=25, color="red"),
                text=[f"震央<br>({epicenter_lat:.3f}, {epicenter_lon:.3f})"],
                hoverinfo="text",
                name="震央",
                showlegend=True,
            )
        )

        fig.add_trace(
            go.Scattermap(
                lat=[epicenter_lat],
                lon=[epicenter_lon],
                mode="markers",
                marker=dict(size=10, color="white"),
                showlegend=False,
                hoverinfo="skip",
            )
        )

    # 設置地圖佈局
    fig.update_layout(
        map=dict(
            style="open-street-map",
            center=dict(lat=map_center_lat, lon=map_center_lon),
            zoom=6.5,
        ),
        height=550,  # 設置固定高度以適應 Gradio 容器
        margin=dict(l=0, r=0, t=0, b=0),
        hovermode="closest",  # 啟用 hover 功能
        showlegend=True,
        legend=dict(
            yanchor="top",
            y=0.95,
            xanchor="left",
            x=0.01,
            bgcolor="rgba(255, 255, 255, 0.8)",
        ),
    )

    return fig


def load_observed_intensity_image(event_name):
    """
    從 intensity_map 資料夾載入對應的實際觀測震度圖

    實際震度圖不存在時：顯示提示並用預設高度 800 呈現空白占位
    """
    import os

    image_path = earthquake_metadata[event_name]["intensity_map_file"]
    if os.path.exists(image_path):
        logger.info(f"載入實際觀測震度圖: {image_path}")
        return image_path

    logger.warning(f"找不到實際震度圖: {event_name}（將顯示空白占位）")
    return None


# ============ 步驟 1：載入 mseed + 選擇測站（快取到 gr.State）============
def step1_load_mseed_and_select_stations(event_name):
    """
    步驟 1：載入 mseed 檔案並選擇最近的 25 個測站

    這一步只執行一次（切換事件時），結果會快取在 gr.State 中
    """
    try:
        epicenter_lat = earthquake_metadata[event_name]["epicenter_lat"]
        epicenter_lon = earthquake_metadata[event_name]["epicenter_lon"]
        mseed_file = earthquake_metadata[event_name]["mseed_file"]

        logger.info(f"[步驟 1] 載入地震事件: {event_name}")
        st = read(mseed_file)
        logger.info(f"載入了 {len(st)} 個 trace")

        # 選擇距離震央最近的 25 個測站（啟用 STA/LTA 快取）
        logger.info(f"選擇距離震央 ({epicenter_lat}, {epicenter_lon}) 最近的測站...")
        selected_stations = select_nearest_stations(
            st, epicenter_lat, epicenter_lon, n_stations=25, event_name=event_name
        )

        if len(selected_stations) == 0:
            logger.error("找不到有效的測站資料")
            return None, None

        logger.info(f"[步驟 1] 完成 - mseed 已載入，測站已選擇，STA/LTA 結果已快取（{len(selected_stations)} 個測站）")
        return st, selected_stations

    except Exception as e:
        logger.error(f"[步驟 1] 發生錯誤: {e}")
        import traceback
        traceback.print_exc()
        return None, None


# ============ 步驟 2：提取波形（使用快取的 stream + stations）============
def step2_extract_and_plot_waveforms(cached_stream, cached_stations, event_name,
                                     duration):
    """
    步驟 2：根據時間範圍提取波形並繪圖

    使用快取的 stream 和 selected_stations，避免重複讀檔
    用戶調整時間範圍時會重複執行此步驟
    """
    try:
        if cached_stream is None or cached_stations is None:
            logger.warning("[步驟 2] 快取資料不存在，請先載入波形")
            return None, None, None, gr.update(interactive=False)

        first_pick = earthquake_metadata[event_name]["first_pick"]

        logger.info(f"[步驟 2] 提取波形資料（P 波後 {duration} 秒，使用快取的測站與 STA/LTA 資訊）...")

        # 提取波形資料
        (waveforms, station_info_list, valid_stations,
         missing_components_count, p_wave_outside_window_count) = (
            extract_waveforms_from_stream(
                event_name, cached_stream, cached_stations, duration, vs30_input=600
            )
        )

        if len(waveforms) == 0:
            logger.error("[步驟 2] 無法提取波形資料")
            return None, None, None

        # 繪製波形圖（包含所有 cached_stations，含 P 波標記）
        waveform_plot = plot_waveform(cached_stream, cached_stations, first_pick,
                                      duration)

        logger.info(f"[步驟 2] 完成 - 已提取 {len(waveforms)} 個測站的波形")
        return waveforms, station_info_list, waveform_plot

    except Exception as e:
        logger.error(f"[步驟 2] 發生錯誤: {e}")
        import traceback
        traceback.print_exc()
        return None, None, None


# ============ 步驟 3：執行模型推論（使用快取的波形）============
def step3_predict_intensity(cached_waveforms, cached_station_info, cached_stations,
                            event_name, duration):
    """
    步驟 3：執行震度預測

    直接使用快取的波形資料和測站資訊，無需重新讀檔或提取波形

    spec #2：測站選擇上限 (25 站)、波形取樣率 (100 Hz)、時間窗長度 (30 秒)
    spec #3：推論流程、PGA → 震度轉換

    注意：此函數只返回預測地圖，觀測圖片由 step1 單獨處理
    """
    try:
        if cached_waveforms is None or cached_station_info is None:
            logger.warning("[步驟 3] 快取資料不存在，請先載入並提取波形")
            return None

        epicenter_lat = earthquake_metadata[event_name]["epicenter_lat"]
        epicenter_lon = earthquake_metadata[event_name]["epicenter_lon"]
        first_pick = earthquake_metadata[event_name]["first_pick"]

        logger.info("[步驟 3] 開始模型推論...")

        # Padding 到 25 個測站（模型要求）
        max_stations = 25
        waveform_padded = np.zeros((max_stations, 3000, 3))
        station_info_padded = np.zeros((max_stations, 4))

        for i in range(min(len(cached_waveforms), max_stations)):
            waveform_padded[i] = cached_waveforms[i]
            station_info_padded[i] = cached_station_info[i]

        # 準備所有目標測站資訊（分批處理）
        all_pga_list = []
        all_target_names = []

        # 計算需要分幾批（每批 25 個測站）
        batch_size = 25
        total_targets = len(target_dict)
        num_batches = (total_targets + batch_size - 1) // batch_size

        logger.info(
            f"開始分批預測 {total_targets} 個目標測站（共 {num_batches} 批）..."
        )

        for batch_idx in range(num_batches):
            start_idx = batch_idx * batch_size
            end_idx = min((batch_idx + 1) * batch_size, total_targets)
            batch_targets = target_dict[start_idx:end_idx]

            logger.info(
                f"預測第 {batch_idx + 1}/{num_batches} 批（測站 {start_idx + 1}-{end_idx}）..."
            )

            # 準備這批目標測站資訊
            target_list = []
            target_names = []
            for target in batch_targets:
                target_list.append(
                    [
                        target["latitude"],
                        target["longitude"],
                        target["elevation"],
                        get_vs30(
                            target["latitude"], target["longitude"], user_vs30=600
                        ),
                    ]
                )
                target_names.append(target["station"])

            # Padding 到 25 個（如果不足 25 個）
            target_padded = np.zeros((batch_size, 4))
            for i in range(len(target_list)):
                target_padded[i] = target_list[i]

            # 組合成 torch tensor
            tensor_data = {
                "waveform": torch.tensor(waveform_padded).unsqueeze(0).double(),
                "station": torch.tensor(station_info_padded).unsqueeze(0).double(),
                "target": torch.tensor(target_padded).unsqueeze(0).double(),
            }

            # 執行預測
            with torch.no_grad():
                weight, sigma, mu = model(tensor_data)
                batch_pga = (
                    torch.sum(weight * mu, dim=2)
                    .cpu()
                    .detach()
                    .numpy()
                    .flatten()
                    .tolist()
                )

            # 只取實際有資料的部分
            all_pga_list.extend(batch_pga[: len(target_names)])
            all_target_names.extend(target_names)

        logger.info(f"完成所有 {len(all_target_names)} 個測站的預測！")
        pga_list = all_pga_list
        target_names = all_target_names

        # 繪製互動式地圖（固定高度 800）- 合併輸入測站與預測震度
        # 根據 P 波到時是否在時間窗內調整輸入測站透明度
        intensity_map = create_intensity_map(
            pga_list, target_names, epicenter_lat, epicenter_lon,
            selected_stations=cached_stations, duration=duration, first_pick=first_pick
        )

        # 生成警報文字報告
        alert_report = generate_earthquake_alert_report(
            pga_list, target_names, event_name, duration
        )

        logger.info("[步驟 3] 預測完成！")
        return intensity_map, alert_report

    except Exception as e:
        logger.error(f"[步驟 3] 發生錯誤: {e}")
        import traceback

        traceback.print_exc()
        return None, ""


# ============ Gradio 介面 ============
with gr.Blocks(title="TT-SAM 震度預測模型", fill_height=True) as demo:
    gr.Markdown("# Taiwan Transformer Shaking Alert Model (TT-SAM)")

    # ========== 上層：使用說明與參數設定 ==========
    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown(
                """
                **流程說明**：
                1. 使用 P 波偵測選出距震央最近最多 25 個測站（有 P 波才會有波形，沒有的話補 0）
                2. 提取測站資訊（經緯度、高程、Vs30）與 P 波後指定時間長度的三分量波形
                3. 波形資料補齊至 30 秒後輸入已訓練好的 TTSAM 模型
                4. 模型預測 47 個目標點的 PGA 並轉換為震度，生成分布地圖
                5. 將預測結果按縣市歸納，取各縣市最高震度，並按震度大小排序生成文字報告（僅顯示 4 級以上地區） 
                """
            )
        with gr.Column(scale=1):
            event_dropdown = gr.Dropdown(
                choices=list(earthquake_metadata.keys()),
                value=list(earthquake_metadata.keys())[2],
                label="選擇地震事件",
            )
            duration_slider = gr.Slider(
                2, 15, value=15, step=1, label="P 波後時間 (秒)"
            )
    with gr.Row(scale=1):
        alert_textbox = gr.Textbox(
            label="地震預警報告（≥ 4 級地區）",
            lines=7,
            max_lines=7,
            interactive=False,
            show_copy_button=False,
            autoscroll=False,
        )

        waveform_plot = gr.Plot(
            label="地震波形",
        )

    # ========== 下層：合併地圖 vs 實際觀測 ==========
    with gr.Row():
        predicted_intensity_map = gr.Plot(label="預測震度")

        observed_intensity_image = gr.Image(
            label="實際觀測震度",
            type="filepath",
            value=load_observed_intensity_image(
                list(earthquake_metadata.keys())[2]),
        )
    with gr.Row():
        gr.Markdown(
            """
            **注意事項**：
            - 模型僅供研究與教育用途，請勿用於正式警報系統。
            - 預測結果可能因測站分布、波形品質等因素有所差異。
            - 實際觀測震度圖來自中央氣象署。
            """
        )
        gr.Markdown(
            """
            TT-SAM 模型由國立中央大學地球科學系與國立台灣大學地質科學系合作開發。
            - 氣象署計畫：人工智慧技術建立微分區地震預警系統相關研究 (MOTC-CWB-110-E-06)
            - 模型：https://github.com/JasonChang0320/TT-SAM 
            - 即時監測系統：https://github.com/SeisBlue/TTSAM_Realtime
            """
        )

    # ========== 隱藏的 State 變數（用於快取中間結果）==========
    cached_stream = gr.State(None)  # ObsPy Stream object
    cached_stations = gr.State(None)  # 選中的 25 個測站列表
    cached_waveforms = gr.State(None)  # 提取的波形資料
    cached_station_info = gr.State(None)  # 測站資訊列表

    # ========== 事件綁定（使用鏈式觸發 + gr.State 快取）==========

    # 【觸發點 1】事件切換：自動執行完整流程 步驟 1 → 步驟 2 → 步驟 3 + 載入觀測圖片
    event_dropdown.change(
        fn=step1_load_mseed_and_select_stations,
        inputs=[event_dropdown],
        outputs=[cached_stream, cached_stations]
    ).then(  # 載入觀測圖片（只在事件切換時執行）
        fn=load_observed_intensity_image,
        inputs=[event_dropdown],
        outputs=[observed_intensity_image]
    ).then(  # 鏈式觸發步驟 2
        fn=step2_extract_and_plot_waveforms,
        inputs=[cached_stream, cached_stations, event_dropdown, duration_slider],
        outputs=[cached_waveforms, cached_station_info, waveform_plot]
    ).then(  # 鏈式觸發步驟 3
        fn=step3_predict_intensity,
        inputs=[cached_waveforms, cached_station_info, cached_stations, event_dropdown, duration_slider],
        outputs=[predicted_intensity_map, alert_textbox]
    )

    # 【觸發點 2】時間範圍調整：自動執行步驟 2 → 步驟 3（不重新讀檔，不更新觀測圖片）
    duration_slider.change(
        fn=step2_extract_and_plot_waveforms,
        inputs=[cached_stream, cached_stations, event_dropdown, duration_slider],
        outputs=[cached_waveforms, cached_station_info, waveform_plot]
    ).then(  # 鏈式觸發步驟 3
        fn=step3_predict_intensity,
        inputs=[cached_waveforms, cached_station_info, cached_stations, event_dropdown, duration_slider],
        outputs=[predicted_intensity_map, alert_textbox]
    )

    # 【冷啟動】應用載入時自動執行完整流程 步驟 1 → 載入觀測圖片 → 步驟 2 → 步驟 3
    demo.load(
        fn=step1_load_mseed_and_select_stations,
        inputs=[event_dropdown],
        outputs=[cached_stream, cached_stations]
    ).then(
        fn=load_observed_intensity_image,
        inputs=[event_dropdown],
        outputs=[observed_intensity_image]
    ).then(
        fn=step2_extract_and_plot_waveforms,
        inputs=[cached_stream, cached_stations, event_dropdown, duration_slider],
        outputs=[cached_waveforms, cached_station_info, waveform_plot]
    ).then(
        fn=step3_predict_intensity,
        inputs=[cached_waveforms, cached_station_info, cached_stations, event_dropdown, duration_slider],
        outputs=[predicted_intensity_map, alert_textbox]
    )

demo.launch()
