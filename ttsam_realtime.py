import argparse
import bisect
import json
import os
import sys
import threading
import time
from datetime import datetime

import numpy as np
import paho.mqtt.client as mqtt
import pandas as pd
import PyEW
import torch
import torch.multiprocessing as mp
import xarray as xr
from discord_webhook import DiscordEmbed, DiscordWebhook
from flask import Flask, request
from flask_cors import CORS
from flask_socketio import SocketIO
from huggingface_hub import hf_hub_download
from loguru import logger
from scipy.signal import detrend, iirfilter, sosfilt, zpk2sos
from scipy.spatial import cKDTree

# 初始化 multiprocessing 共享物件
manager = mp.Manager()
wave_buffer = manager.dict()
wave_queue = manager.Queue()
pick_buffer = manager.dict()
event_queue = manager.Queue()
dataset_queue = manager.Queue()
report_queue = manager.Queue()
discord_queue = manager.Queue()
wave_endt = manager.Value("d", 0)
wave_speed_count = manager.Value("i", 0)

app = Flask(__name__)
# HTTP API 的 CORS
CORS(app, resources={r"/api/*": {"origins": "*"}})

# SocketIO 的 CORS（獨立處理 WebSocket）
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# 訂閱管理：追蹤每個客戶端訂閱的測站
subscribed_stations = {}  # {session_id: set(station_codes)}

"""
Web Server
"""


@app.route("/api/get_file_content")
def get_file_content():
    report_log_dir = "/workspace/logs/report"
    file_name = request.args.get("file")
    if not file_name.startswith("report"):
        return "Invalid file type", 400

    if not file_name.endswith(".log"):
        return "Invalid file type", 400

    # 檢查文件名是否包含相對路徑
    if ".." in file_name or "/" in file_name or "\\" in file_name:
        return "Invalid file name", 400

    try:
        file_path = os.path.join(report_log_dir, file_name)
        with open(file_path, "r", encoding="utf-8") as file:
            content = file.read()
        return content

    except Exception as e:
        return str(e), 500


@app.route("/api/stations")
def get_stations():
    """API: 取得測站列表（JSON格式）"""
    try:
        return (
            json.dumps(target_dict, ensure_ascii=False),
            200,
            {"Content-Type": "application/json; charset=utf-8"},
        )
    except Exception as e:
        logger.error(f"Error getting stations: {e}")
        return (
            json.dumps({"error": str(e)}),
            500,
            {"Content-Type": "application/json; charset=utf-8"},
        )


@app.route("/api/all-stations")
def get_all_stations():
    """API: 取得所有測站列表（用於測站替換功能的經緯度查找）"""
    try:
        return (
            json.dumps(all_stations_dict, ensure_ascii=False),
            200,
            {"Content-Type": "application/json; charset=utf-8"},
        )
    except Exception as e:
        logger.error(f"Error getting all stations: {e}")
        return (
            json.dumps({"error": str(e)}),
            500,
            {"Content-Type": "application/json; charset=utf-8"},
        )


@app.route("/api/reports")
def get_reports():
    """API: 取得歷史預測報告列表（JSON格式）"""
    try:
        report_log_dir = "/workspace/logs/report"
        files = []
        if os.path.exists(report_log_dir):
            for f in os.listdir(report_log_dir):
                file_path = os.path.join(report_log_dir, f)
                if (
                    f.startswith("report")
                    and f.endswith(".log")
                    and os.path.isfile(file_path)
                ):
                    # 獲取文件修改時間
                    mtime = os.path.getmtime(file_path)
                    files.append(
                        {
                            "filename": f,
                            "timestamp": mtime,
                            "datetime": datetime.fromtimestamp(mtime).strftime(
                                "%Y-%m-%d %H:%M:%S"
                            ),
                        }
                    )

        # 按時間倒序排列
        files.sort(key=lambda x: x["timestamp"], reverse=True)

        return (
            json.dumps(files, ensure_ascii=False),
            200,
            {"Content-Type": "application/json; charset=utf-8"},
        )
    except Exception as e:
        logger.error(f"Error getting reports: {e}")
        return (
            json.dumps({"error": str(e)}),
            500,
            {"Content-Type": "application/json; charset=utf-8"},
        )


@app.route("/api/find-nearest-station")
def find_nearest_station():
    """API: 根據經緯度查找最近的測站
    參數:
        lat: 緯度
        lon: 經度
        exclude_pattern: 排除的測站格式 (可選，例如 "CWASN" 排除非 Axxx/Bxxx/Cxxx 格式)
        max_count: 返回最近的 N 個測站 (預設 1)
    """
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
        exclude_pattern = request.args.get("exclude_pattern", None)
        max_count = int(request.args.get("max_count", 1))

        if not all_stations_dict:
            return (
                json.dumps({"error": "No stations available"}),
                404,
                {"Content-Type": "application/json; charset=utf-8"},
            )

        # 過濾測站
        filtered_stations = all_stations_dict
        if exclude_pattern == "CWASN":
            import re

            tsmip_pattern = re.compile(r"^[ABCDEFGH]\d{3}$")
            filtered_stations = [
                s
                for s in all_stations_dict
                if tsmip_pattern.match(s.get("station", ""))
            ]

        if not filtered_stations:
            return (
                json.dumps({"error": "No matching stations found"}),
                404,
                {"Content-Type": "application/json; charset=utf-8"},
            )

        # 計算距離並排序
        def haversine_distance(lat1, lon1, lat2, lon2):
            """計算兩點間的距離（公里）"""
            from math import asin, cos, radians, sin, sqrt

            lon1, lat1, lon2, lat2 = map(radians, [lon1, lat1, lon2, lat2])
            dlon = lon2 - lon1
            dlat = lat2 - lat1
            a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
            c = 2 * asin(sqrt(a))
            km = 6371 * c
            return km

        stations_with_distance = []
        for station in filtered_stations:
            station_lat = station.get("latitude")
            station_lon = station.get("longitude")
            if station_lat is not None and station_lon is not None:
                distance = haversine_distance(lat, lon, station_lat, station_lon)
                stations_with_distance.append(
                    {**station, "distance_km": round(distance, 2)}
                )

        # 按距離排序
        stations_with_distance.sort(key=lambda x: x["distance_km"])

        # 返回最近的 N 個測站
        result = stations_with_distance[:max_count]

        return (
            json.dumps(result, ensure_ascii=False),
            200,
            {"Content-Type": "application/json; charset=utf-8"},
        )

    except ValueError as e:
        return (
            json.dumps({"error": f"Invalid parameters: {str(e)}"}),
            400,
            {"Content-Type": "application/json; charset=utf-8"},
        )
    except Exception as e:
        logger.error(f"Error finding nearest station: {e}")
        return (
            json.dumps({"error": str(e)}),
            500,
            {"Content-Type": "application/json; charset=utf-8"},
        )


@socketio.on("connect")
def connect_earthworm():
    socketio.emit("connect_init")


@socketio.on("subscribe_stations")
def handle_subscribe_stations(data):
    """處理前端訂閱測站請求"""
    session_id = request.sid
    stations = data.get("stations", [])

    if stations:
        subscribed_stations[session_id] = set(stations)
        logger.info(
            f"📡 Client {session_id[:8]} subscribed to {len(stations)} stations"
        )
    else:
        # 清空訂閱
        if session_id in subscribed_stations:
            del subscribed_stations[session_id]
        logger.info(f"📡 Client {session_id[:8]} unsubscribed from all stations")


@socketio.on("disconnect")
def handle_disconnect():
    """客戶端斷線時清理訂閱"""
    session_id = request.sid
    if session_id in subscribed_stations:
        del subscribed_stations[session_id]
        logger.info(f"🔌 Client {session_id[:8]} disconnected, subscription removed")


def _process_wave_data(wave, is_realtime=False):
    """處理單個波形數據，提取並格式化"""
    waveform_data = wave["data"]

    # 進行訊號處理
    processed_data = signal_processing(waveform_data)
    if processed_data is not None:
        waveform_data = processed_data

    if isinstance(waveform_data, np.ndarray):
        waveform_list = waveform_data.tolist()
        pga = float(np.max(np.abs(waveform_data)))
    elif isinstance(waveform_data, list):
        waveform_list = waveform_data
        pga = float(max(abs(x) for x in waveform_data)) if waveform_data else 0.0
    else:
        return None

    return {
        "waveform": waveform_list,
        "pga": pga,
        "status": "active",
        "startt": wave.get("startt", 0),
        "endt": wave.get("endt", 0),
        "samprate": wave.get("samprate", 100),
        "is_realtime": is_realtime,
    }


def wave_emitter():
    """按需推送波形數據 - 只發送被訂閱的測站"""
    batch_interval = 0.1
    last_send_time = time.time()

    while True:
        try:
            wave_batch = {}
            current_time = time.time()

            # 收集一定時間內的所有波形數據
            while current_time - last_send_time < batch_interval:
                try:
                    wave = wave_queue.get(timeout=0.05)
                    wave_id = join_id_from_dict(wave, order="NSLC")

                    if "Z" not in wave_id:
                        continue

                    # 處理波形數據
                    processed = _process_wave_data(wave, is_realtime=False)
                    if processed:
                        wave_batch[wave_id] = processed

                except:
                    pass

                current_time = time.time()

            # 發送數據
            if wave_batch and subscribed_stations:
                all_subscribed = set()
                for stations_set in subscribed_stations.values():
                    all_subscribed.update(stations_set)

                filtered_batch = {}
                for wave_id, wave_data in wave_batch.items():
                    station_code = wave_id.split(".")[1] if "." in wave_id else wave_id
                    if station_code in all_subscribed:
                        filtered_batch[wave_id] = wave_data

                if filtered_batch:
                    timestamp = int(time.time() * 1000)
                    wave_packet = {
                        "waveid": f"batch_{timestamp}",
                        "timestamp": timestamp,
                        "data": filtered_batch,
                    }
                    socketio.emit("wave_packet", wave_packet)
                    logger.debug(
                        f"📦 Batch sent: {len(filtered_batch)}/{len(wave_batch)} stations"
                    )

            last_send_time = current_time

        except Exception as e:
            logger.error(f"Error in wave_emitter: {e}")
            time.sleep(0.1)
            continue


def report_emitter():
    while True:
        report_data = report_queue.get()
        if not report_data:
            continue

        socketio.emit("report_data", report_data)


def web_server():
    """啟動 Web Server 與 SocketIO"""
    logger.info("Starting web server...")

    # 啟動背景資料發送執行緒
    threading.Thread(target=wave_emitter, daemon=True).start()
    threading.Thread(target=report_emitter, daemon=True).start()

    app.run(host=args.host, port=args.port, use_reloader=False)
    socketio.run(app, host=args.host, port=args.port, debug=True)


"""
Earthworm Wave Listener
"""

# Load site info
site_info_file = "/workspace/station/site_info.csv"
try:
    logger.info(f"Loading {site_info_file}...")
    site_info = pd.read_csv(site_info_file)
    constant_dict = site_info.set_index(["Station", "Channel"])["Constant"].to_dict()
    logger.info(f"{site_info_file} loaded")

except FileNotFoundError:
    logger.warning(f"{site_info_file} not found")


def join_id_from_dict(data, order="NSLC"):
    code = {"N": "network", "S": "station", "L": "location", "C": "channel"}
    data_id = ".".join(data[code[letter]] for letter in order)
    return data_id


def convert_to_tsmip_legacy_naming(wave):
    if wave["network"] == "TW":
        wave["network"] = "SM"
        wave["location"] = "01"
    return wave


def get_wave_constant(wave):
    # count to cm/s^2
    try:
        wave_constant = constant_dict[wave["station"], wave["channel"]]

    except Exception as e:
        logger.debug(
            f"{wave['station']} not found in site_info.txt, use default 3.2e-6"
        )
        wave_constant = 3.2e-6

    return wave_constant


def wave_array_init(sample_rate, buffer_time, fill_value):
    return np.full(sample_rate * buffer_time, fill_value=fill_value)


def time_array_init(sample_rate, buffer_time, start_time, end_time, data_length):
    """
    生成一個時間序列，包含前後兩段
    後段從 start_time 內插至 end_time (確定的時間序列)
    前段從 start_time 外插至 buffer 開始點 (往前預估的時間序列)
    """
    return np.append(
        np.linspace(
            start_time - (buffer_time - 1),
            start_time,
            sample_rate * (buffer_time - 1),
        ),
        np.linspace(start_time, end_time, data_length),
    )


def slide_array(array, data):
    array = np.append(array, data)
    return array[data.size :]


def earthworm_wave_listener(buf_ring):
    buffer_time = 30  # 設定緩衝區保留時間
    sample_rate = 100  # 設定取樣率

    # 預先計算常數，避免重複查詢
    wave_constant_cache = {}
    wave_buffer_local = {}  # 本地緩存，減少 Manager.dict 訪問

    while True:
        if not earthworm.mod_sta():
            continue

        wave = earthworm.get_wave(buf_ring)
        if not wave:
            continue

        # 快速時間檢查（最早過濾）
        wave_endt_val = wave["endt"]
        current_time = time.time()
        if wave_endt_val < current_time - 3 or wave_endt_val > current_time + 1:
            continue

        # 得到最新的 wave 結束時間
        wave_endt.value = wave_endt_val

        try:
            # 內聯 convert_to_tsmip_legacy_naming，避免函數調用
            network = wave["network"]
            if network == "TW":
                network = "SM"
                location = "01"
            else:
                location = wave["location"]

            station = wave["station"]
            channel = wave["channel"]

            # 內聯 join_id_from_dict，避免字串操作開銷
            wave_id = f"{network}.{station}.{location}.{channel}"

            # 快速檢查是否為 Z 通道（提前判斷）
            is_z_channel = "Z" in wave_id

            # 使用緩存獲取 wave_constant
            cache_key = (station, channel)
            if cache_key not in wave_constant_cache:
                try:
                    wave_constant_cache[cache_key] = constant_dict[cache_key]
                except:
                    wave_constant_cache[cache_key] = 3.2e-6

            # 直接在原數據上乘以常數，避免複製
            wave_data = wave["data"] * wave_constant_cache[cache_key]
            wave["data"] = wave_data

            # 將 wave_id 加入 wave_queue 給 wave_emitter 發送至前端
            if is_z_channel:
                wave_queue.put(wave)

            # add new trace to buffer - 使用本地緩存
            if wave_id not in wave_buffer_local:
                # 檢查是否在共享 buffer 中
                if wave_id not in wave_buffer.keys():
                    # wave_buffer 初始化時全部填入 wave 的平均值
                    init_array = wave_array_init(
                        sample_rate, buffer_time, fill_value=wave_data.mean()
                    )
                    wave_buffer[wave_id] = init_array
                    wave_buffer_local[wave_id] = init_array
                else:
                    wave_buffer_local[wave_id] = wave_buffer[wave_id]

            # 更新 buffer
            updated_array = slide_array(wave_buffer_local[wave_id], wave_data)
            wave_buffer_local[wave_id] = updated_array
            wave_buffer[wave_id] = updated_array

            wave_speed_count.value += 1

        except Exception as e:
            logger.error(f"earthworm_wave_process error {e}")


"""
Earthworm Pick Listener
"""


def parse_pick_msg(pick_msg):
    pick_msg_column = pick_msg.split()
    try:
        pick = {
            "station": pick_msg_column[0],
            "channel": pick_msg_column[1],
            "network": pick_msg_column[2],
            "location": pick_msg_column[3],
            "lon": pick_msg_column[4],
            "lat": pick_msg_column[5],
            "pga": pick_msg_column[6],
            "pgv": pick_msg_column[7],
            "pd": pick_msg_column[8],
            "tc": pick_msg_column[9],  # Average period
            "pick_time": pick_msg_column[10],
            "weight": pick_msg_column[11],  # 0:best 5:worst
            "instrument": pick_msg_column[12],  # 1:Acc 2:Vel
            "update_sec": pick_msg_column[13],  # sec after pick
        }

        pick["pickid"] = join_id_from_dict(pick, order="NSLC")

        return pick

    except IndexError as e:
        logger.error(f"pick_msg parsing error: {pick_msg_column}, {e}")


def earthworm_pick_listener(buf_ring):
    """
    監看 pick ring 的訊息，並將 pick 加入 pick_buffer
    pick msg 的時間窗為 p 波後 2-10 秒
    ref: pick_ew_new/pick_ra_0709.c line 283
    """
    event_window = 10
    while True:
        try:
            # 超時移除 pick
            for pick_id, buffer_pick in pick_buffer.items():
                if float(buffer_pick["sys_time"]) + event_window < time.time():
                    pick_buffer.__delitem__(pick_id)
                    logger.debug(f"delete pick: {pick_id}")
        except BrokenPipeError:
            break

        except Exception as e:
            logger.error(f"delete pick error: {pick_id}, {e}")

        # 取得 pick msg
        pick_msg = earthworm.get_msg(buf_ring=buf_ring, msg_type=0)
        if not pick_msg:
            time.sleep(0.00001)
            continue
        logger.debug(f"{pick_msg}")

        # PickRing trace gap 太大會有 Restarting 的訊息
        if "Restarting" in pick_msg:
            continue

        # PickRing 的未知短訊息，如：1732070774 124547
        if len(pick_msg.split()) < 13:
            continue

        try:
            pick_data = parse_pick_msg(pick_msg)
            pick_id = join_id_from_dict(pick_data, order="NSLC")

            # 跳過程式啟動前殘留在 shared memory 的 Pick
            if time.time() > float(pick_data["pick_time"]) + 10:
                continue

            # upsec 為 2 秒時加入 pick
            if pick_data["update_sec"] == "2":
                print(pick_msg)
                sys.stdout.flush()

                # 以系統時間作為時間戳記
                pick_data["sys_time"] = time.time()
                pick_buffer[pick_id] = pick_data
                logger.debug(f"add pick: {pick_id}")

        except Exception as e:
            logger.error(f"earthworm_pick_listener error: {pick_msg}, {e}")
            continue
        time.sleep(0.00001)


"""
Earthworm EEW Listener
"""


def earthworm_eew_listener(buf_ring):
    while True:
        try:
            # 取得 pick msg
            eew_msg = earthworm.get_msg(buf_ring=buf_ring, msg_type=0)
            if not eew_msg:
                time.sleep(0.00001)
                continue
            print(eew_msg)
            sys.stdout.flush()
            logger.debug(f"{eew_msg}")

        except Exception as e:
            logger.error(f"earthworm_eew_listener error: {eew_msg}, {e}")
            continue
        time.sleep(0.00001)


"""
Model Inference
"""
# Load Vs30 grid
try:
    vs30_file = "/workspace/station/Vs30ofTaiwan.nc"
    ds = xr.open_dataset(vs30_file)
    logger.info("Using local Vs30 file path")
except FileNotFoundError:
    vs30_file = hf_hub_download(
        repo_id="SeisBlue/TaiwanVs30",
        filename="Vs30ofTaiwan.nc",
        local_dir="/workspace/station",
        repo_type="dataset",
    )
    ds = xr.open_dataset(vs30_file)
    logger.info("Using huggingface Vs30 file path")

try:
    # 將 2D 座標展平成 1D 陣列供 KDTree 使用
    lat_flat = ds["lat"].values.flatten()
    lon_flat = ds["lon"].values.flatten()
    vs30_flat = ds["vs30"].values.flatten()

    # 建立查詢表格
    vs30_table = pd.DataFrame({"lat": lat_flat, "lon": lon_flat, "Vs30": vs30_flat})

    # 移除包含 NaN 或 Inf 的資料
    vs30_table = vs30_table.replace([np.inf, -np.inf], np.nan)
    vs30_table = vs30_table.dropna()

    logger.info(f"Valid data points: {len(vs30_table)}")

    tree = cKDTree(vs30_table[["lat", "lon"]])
    logger.info(f"{vs30_file} loaded")
except FileNotFoundError:
    logger.error(f"{vs30_file} not found")

# Load target station
target_file = "/workspace/station/eew_target.csv"
try:
    logger.info(f"Loading {target_file}...")
    target_df = pd.read_csv(target_file)
    target_dict = target_df.to_dict(orient="records")
    logger.info(f"{target_file} loaded")

except FileNotFoundError:
    logger.error(f"{target_file} not found")

# Load all stations from site_info.csv (for secondary stations display)
all_stations_dict = []
site_info_file = "/workspace/station/site_info.csv"
try:
    logger.info(f"Loading {site_info_file}...")
    site_info_df = pd.read_csv(site_info_file)

    # 只取 HLZ 通道且仍在運作的測站（End_time = 2599-12-31）
    active_stations = site_info_df[
        (site_info_df["Channel"] == "HLZ") & (site_info_df["End_time"] == "2599-12-31")
    ].copy()

    # 去重（同一測站可能有多條記錄）
    active_stations = active_stations.drop_duplicates(subset=["Station"])

    # 轉換為字典格式
    all_stations_dict = (
        active_stations[["Station", "Latitude", "Longitude"]]
        .rename(
            columns={
                "Station": "station",
                "Latitude": "latitude",
                "Longitude": "longitude",
            }
        )
        .to_dict(orient="records")
    )

    logger.info(
        f"Loaded {len(all_stations_dict)} active stations from {site_info_file}"
    )

except FileNotFoundError:
    logger.warning(
        f"{site_info_file} not found, secondary stations will not be available"
    )
except Exception as e:
    logger.error(f"Error loading {site_info_file}: {e}")


model_path = "/workspace/ttsam_trained_model_11.pt"
try:
    os.path.exists(f"{model_path}")
except FileNotFoundError:
    logger.info(f"Check model weight...")
    model_path = hf_hub_download(
        repo_id="SeisBlue/TTSAM",
        filename="ttsam_trained_model_11.pt",
        local_dir="/workspace",
        repo_type="model",
    )
    logger.info(f"found {model_path} model weight")
    logger.error(f"Error loading {model_path}: {e}")


def event_cutter(pick_buffer):
    event_data = {}
    # pick 只有 Z 軸
    for pick_id, pick in pick_buffer.items():
        network = pick["network"]
        station = pick["station"]
        location = pick["location"]
        channel = pick["channel"]

        data = {}
        # 找到 wave_buffer 內的三軸資料
        for i, component in enumerate(["Z", "N", "E"]):
            try:
                wave_id = f"{network}.{station}.{location}.{channel[0:2]}{component}"
                data[component.lower()] = wave_buffer[wave_id].tolist()

            except KeyError:
                logger.debug(f"{wave_id} {component} not found, add zero array")
                wave_id = f"{network}.{station}.{location}.{channel[0:2]}Z"
                data[component.lower()] = np.zeros(3000).tolist()
                continue

        trace_dict = {
            "traceid": pick_id,
            "data": data,
        }

        event_data[pick_id] = {"pick": pick, "trace": trace_dict}

    event_queue.put(event_data)

    return event_data


def signal_processing(waveform):
    try:
        # demean and lowpass filter
        data = detrend(waveform, type="constant")
        data = lowpass(data, freq=10)

        return data

    except Exception as e:
        logger.error(f"signal_processing error: {e}")


def lowpass(data, freq=10, df=100, corners=4):
    """
    Modified form ObsPy Signal Processing
    https://docs.obspy.org/_modules/obspy/signal/filter.html#lowpass
    """
    fe = 0.5 * df
    f = freq / fe

    if f > 1:
        f = 1.0
    z, p, k = iirfilter(corners, f, btype="lowpass", ftype="butter", output="zpk")
    sos = zpk2sos(z, p, k)

    return sosfilt(sos, data)


def get_vs30(lat, lon):
    try:
        distance, i = tree.query([float(lat), float(lon)])
        vs30 = vs30_table.iloc[i]["Vs30"]
        return float(vs30)

    except Exception as e:
        logger.error(
            f"get_vs30 error: {e}",
        )


def get_station_position(station):
    try:
        latitude, longitude, elevation = site_info.loc[
            (site_info["Station"] == station), ["Latitude", "Longitude", "Elevation"]
        ].values[0]
        return latitude, longitude, elevation
    except Exception as e:
        logger.error(f"get_station_position error: {station}, {e}")
        return


def get_site_info(pick):
    try:
        latitude, longitude, elevation = get_station_position(pick["station"])
        vs30 = get_vs30(latitude, longitude)
        return [latitude, longitude, elevation, vs30]

    except Exception as e:
        logger.debug(f"{pick['station']} not found in site_info, use pick info")
        latitude, longitude, elevation = pick["lat"], pick["lon"], 100
        vs30 = get_vs30(latitude, longitude)
        return [latitude, longitude, elevation, vs30]


def convert_dataset(event_msg):
    try:
        waveform_list = []
        station_list = []
        station_name_list = []

        for i, (pick_id, data) in enumerate(event_msg.items()):
            trace = []
            for j, component in enumerate(["Z", "N", "E"]):
                waveform = data["trace"]["data"][component.lower()]
                waveform = signal_processing(waveform)
                trace.append(waveform.tolist())

            waveform_list.append(trace)
            station_list.append(get_site_info(data["pick"]))
            station_name_list.append(data["pick"]["station"])

        dataset = {
            "waveform": waveform_list,
            "station": station_list,
            "station_name": station_name_list,
            "target": [],
            "target_name": [],
            "pga": [],
        }

        return dataset

    except Exception as e:
        logger.error(f"converter error: {e}")


def dataset_batch(dataset, batch_size=25):
    batch = {}
    try:
        # 固定前 25 站的 waveform
        batch["waveform"] = dataset["waveform"][:batch_size]
        batch["station"] = dataset["station"][:batch_size]
        batch["station_name"] = dataset["station_name"][:batch_size]

        for i in range(0, len(dataset["target"]), batch_size):
            # 迭代 25 站的 target
            batch["target"] = dataset["target"][i : i + batch_size]
            batch["target_name"] = dataset["target_name"][i : i + batch_size]

            yield batch

    except Exception as e:
        logger.error(f"dataset_batch error: {e}")


def get_target_dataset(dataset):
    target_list = []
    target_name_list = []

    for target in target_dict:
        latitude = target["latitude"]
        longitude = target["longitude"]
        elevation = target["elevation"]
        target_list.append(
            [latitude, longitude, elevation, get_vs30(latitude, longitude)]
        )
        target_name_list.append(target["station"])
    dataset["target"] = target_list
    dataset["target_name"] = target_name_list

    return dataset


def get_average_pga(weight, sigma, mu):
    pga_list = torch.sum(weight * mu, dim=2).cpu().detach().numpy().flatten()
    return pga_list.tolist()


def calculate_intensity(pga, pgv=None, label=False):
    try:
        intensity_label = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"]
        pga_level = np.log10(
            [1e-5, 0.008, 0.025, 0.080, 0.250, 0.80, 1.4, 2.5, 4.4, 8.0]
        )  # log10(m/s^2)

        pgv_level = np.log10(
            [1e-5, 0.002, 0.007, 0.019, 0.057, 0.15, 0.3, 0.5, 0.8, 1.4]
        )  # log10(m/s)

        pga_intensity = bisect.bisect(pga_level, pga) - 1
        intensity = pga_intensity

        if pga > pga_level[5] and pgv is not None:
            pgv_intensity = bisect.bisect(pgv_level, pgv) - 1
            if pgv_intensity > pga_intensity:
                intensity = pgv_intensity

        if label:
            return intensity_label[intensity]

        else:
            return intensity

    except Exception as e:
        logger.error(f"calculate_intensity error: {e}")


def prepare_tensor(data, shape, limit):
    # 輸出固定的 tensor shape, 並將資料填入
    tensor_data = np.zeros(shape)
    tensor_limit = min(len(data), limit)
    tensor_data[:tensor_limit] = data[:tensor_limit]
    return torch.tensor(tensor_data).to(torch.double).unsqueeze(0)


def loading_animation(pick_threshold):
    pick_counts = len(pick_buffer)
    loading_chars = ["-", "\\", "|", "/"]

    # 無限循環顯示 loading 動畫
    wave_speed_count.value = 0
    start_time = time.time()
    for char in loading_chars:
        # 清除上一個字符
        sys.stdout.write("\r" + " " * 30 + "\r")
        sys.stdout.flush()

        wave_count = len(wave_buffer)

        wave_timestring = datetime.fromtimestamp(float(wave_endt.value)).strftime(
            "%Y-%m-%d %H:%M:%S.%f"
        )

        delay = time.time() - wave_endt.value

        delta = time.time() - start_time
        wave_process_rate = wave_speed_count.value / delta if delta > 0 else 0

        # 顯示目前的 loading 字符
        sys.stdout.write(
            f"{wave_count} waves: {wave_timestring[:-3]} rate: {wave_process_rate:.3f} lag:{delay:.3f}s picks:{pick_counts}/{pick_threshold} {char} "
        )
        sys.stdout.flush()
        time.sleep(0.1)


def model_inference():
    """
    進行模型預測
    """
    from ttsam_model import get_full_model
    full_model = get_full_model(model_path)

    pick_threshold = 5

    report_log_file = None
    while True:
        # 小於 5 個測站不觸發模型預測
        if len(pick_buffer) < pick_threshold:
            if report_log_file:
                report_log_file.close()

            # 重置 report_log_file
            report_log_file = None
            loading_animation(pick_threshold)
            continue

        if len(pick_buffer) >= pick_threshold:
            if not report_log_file:
                # 當觸發模型預測時，開始記錄 log
                # 取得第一個 pick 的時間
                event_first_pick = list(pick_buffer.values())[0]
                first_pick_timestring = datetime.fromtimestamp(
                    float(event_first_pick["pick_time"]),
                ).strftime("%Y%m%d_%H%M%S")

                # 以第一個 pick 的時間為 report log 檔案名稱
                report_log_file = (
                    f"/workspace/logs/report/report_{first_pick_timestring}.log"
                )
                os.makedirs(os.path.dirname(report_log_file), exist_ok=True)
                logger.info(f"create report log file {report_log_file}")
                report_log_file = open(report_log_file, "w+")

                pick_log_file = f"/workspace/logs/pick/pick_{first_pick_timestring}.log"
                os.makedirs(os.path.dirname(pick_log_file), exist_ok=True)
                logger.info(f"create pick log file {pick_log_file}")
                pick_log_file = open(pick_log_file, "w+")

        try:
            pick_count = len(pick_buffer)
            print(f"{pick_count} picks in window, model inference start")
            sys.stdout.flush()

            wave_endtime = wave_endt.value  # 獲得最新的 wave 結束時間
            inference_start_time = time.time()

            event_data = event_cutter(pick_buffer)
            dataset = convert_dataset(event_data)
            dataset = get_target_dataset(dataset)

            # 模型預測所有 target
            for batch in dataset_batch(dataset):
                wave = np.array(batch["waveform"])
                wave_transposed = wave.transpose(0, 2, 1)

                batch_waveform = prepare_tensor(wave_transposed, (25, 3000, 3), 25)
                batch_station = prepare_tensor(batch["station"], (25, 4), 25)
                batch_target = prepare_tensor(batch["target"], (25, 4), 25)

                tensor = {
                    "waveform": batch_waveform,
                    "station": batch_station,
                    "station_name": batch["station_name"],
                    "target": batch_target,
                    "target_name": batch["target_name"],
                }

                # 模型預測
                weight, sigma, mu = full_model(tensor)
                pga_list = get_average_pga(weight, sigma, mu)
                dataset["pga"].extend(pga_list)

            dataset["intensity"] = [
                calculate_intensity(pga, label=True) for pga in dataset["pga"]
            ]

            # 產生報告
            report = {"picks": len(pick_buffer), "log_time": "", "alarm": []}
            for i, target_name in enumerate(dataset["target_name"]):
                intensity = dataset["intensity"][i]
                report[f"{target_name}"] = intensity

                if intensity in ["4", "5-", "5+", "6-", "6+", "7"]:
                    # 過預警門檻值的測站
                    report["alarm"].append(target_name)

            inference_end_time = time.time()
            report["report_time"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
            report["format_time"] = datetime.now().strftime("%Y%m%d_%H%M%S")
            report["wave_time"] = wave_endtime - float(event_first_pick["pick_time"])
            report["wave_endt"] = datetime.fromtimestamp(float(wave_endtime)).strftime(
                "%Y-%m-%d %H:%M:%S.%f"
            )
            report["wave_lag"] = inference_end_time - wave_endtime
            report["run_time"] = inference_end_time - inference_start_time
            # log_time 加上 2 秒為 pick msg 的 upsec 2 秒
            report["log_time"] = (
                f"{inference_end_time - event_first_pick['sys_time'] + 2:.4f}"
                # upsec 2 sec
            )
            report_queue.put(report)
            report_log_file.write(json.dumps(report) + "\n")

            pick_log = {
                "log_time": report["log_time"],
                "picks": list(pick_buffer.values()),
            }
            pick_log_file.write(json.dumps(pick_log) + "\n")

            # 資料傳至前端
            dataset_queue.put(dataset)
        except Exception as e:
            logger.error(f"model_inference error: {e}")
            continue


def convert_intensity(value):
    if value.endswith("+"):
        return float(value[:-1]) + 0.25
    elif value.endswith("-"):
        return float(value[:-1]) - 0.25
    else:
        return float(value)


def reporter():
    """
    累積發送預警之測站，辨識其行政區，每隔一秒檢查是否有新增行政區，避免在短時間內重複發送警報，如果 pick < 5 則重置
    """
    station_list = []
    station_info = {}
    for target in target_dict:
        station_list.append(target["station"])
        station_info[target["station"]] = {
            "station_zh": target["station_zh"],
            "county": target["county"],
        }

    alarm_county = {}
    past_alarm_county = {}
    new_alarm_county = {}
    start_time = time.time()
    while True:
        report = report_queue.get()

        for station in station_list:
            intensity = report.get(station, "N/A")
            if intensity in ["4", "5-", "5+", "6-", "6+", "7"]:
                county = station_info[station]["county"]
                if county not in alarm_county:
                    alarm_county[county] = intensity
                else:
                    alarm_county[county] = max(
                        alarm_county[county], intensity, key=convert_intensity
                    )

        if time.time() - start_time < 1:
            time.sleep(0.1)
            continue

        for county, intensity in alarm_county.items():
            if county not in past_alarm_county:
                new_alarm_county[county] = intensity

            elif convert_intensity(intensity) > convert_intensity(
                past_alarm_county[county]
            ):
                new_alarm_county[county] = intensity

        if new_alarm_county:
            report["alarm_county"] = alarm_county
            report["new_alarm_county"] = new_alarm_county
            format_report = format_earthquake_report(report)
            print(format_report)
            sys.stdout.flush()

            with open(
                f"/workspace/logs/format_report/text_report_{report['format_time']}.log",
                "a",
            ) as f:
                f.write(format_report + "\n")

            # 報告傳至 Discord
            discord_queue.put(format_report)
            if args.mqtt:
                # 報告傳至 MQTT
                mqtt_client.publish(topic, json.dumps(report))

            past_alarm_county.update(new_alarm_county)
            new_alarm_county = {}

        start_time = time.time()

        if len(pick_buffer) < 5:
            alarm_county = {}
            new_alarm_county = {}
            past_alarm_county = {}


def format_earthquake_report(raw_report):
    report_lines = []
    report_lines.append("--------------------------------------------------")
    report_lines.append("【地震預警報告】")
    report_lines.append("")

    # 摘要部分
    report_lines.append(f"警報時間：{raw_report['report_time']}")
    report_lines.append("")
    if "new_alarm_county" in raw_report:
        report_lines.append("【新增警報】")
        county_list = []
        for county, intensity in raw_report["new_alarm_county"].items():
            county_list.append([intensity, county])
        county_list = sorted(
            county_list, key=lambda x: convert_intensity(x[0]), reverse=True
        )
        for intensity, county in county_list:
            report_lines.append(f"{county}：{intensity} 級以上")

        report_lines.append("")

    # 詳細技術資訊部分
    report_lines.append("【系統資訊】")
    report_lines.append(f"波形延遲：{raw_report['wave_lag']:.2f} 秒")
    report_lines.append(f"累積波型：{raw_report['wave_time']:.2f} 秒")
    report_lines.append(f"計算時間：{raw_report['run_time']:.4f} 秒")
    report_lines.append("")
    report_lines.append("--------------------------------------------------")

    return "\n".join(report_lines)


def send_discord():
    proxies = {}
    try:
        proxies = config["discord"]["proxies"]
    except KeyError:
        logger.debug("discord_webhook no proxy")

    webhook_url = config["discord"]["webhook_url"]
    webhook = DiscordWebhook(url=webhook_url)

    if proxies:
        webhook.set_proxies(proxies)
        logger.info("discord_webhook proxies set")

    if args.discord:
        embed = DiscordEmbed(title="Server start", color="2196F3")
        embed.set_timestamp()
        webhook.add_embed(embed)

        response = webhook.execute()
        logger.debug(response)

        webhook.remove_embeds()

    while True:
        try:
            report = discord_queue.get()

            context = {
                "title": "地震預警",
                "description": report,
                "color": "FF5722",
            }

            embed = DiscordEmbed(**context)
            webhook.add_embed(embed)

            if args.discord:
                response = webhook.execute()
                logger.debug(response)

            webhook.remove_embeds()

        except Exception as e:
            logger.error(f"send_discord error: {e}")
            print(e)


if __name__ == "__main__":
    logger.info("TTSAM Realtime Start")
    parser = argparse.ArgumentParser()
    parser.add_argument("--mqtt", action="store_true", help="connect to mqtt broker")
    parser.add_argument("--discord", action="store_true", help="connect to discord bot")
    parser.add_argument("--web", action="store_true", help="run web server")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="web server ip")
    parser.add_argument("--port", type=int, default=5001, help="web server port")
    parser.add_argument(
        "--env",
        type=str,
        default="cwa",
        choices=["cwa", "test", "jimmy"],
        help="set environment",
    )
    parser.add_argument(
        "--verbose-level",
        type=str,
        default="INFO",
        help="change verbose level: ERROR, WARNING, INFO, DEBUG",
    )
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        help="change log level: ERROR, WARNING, INFO, DEBUG",
    )
    args = parser.parse_args()
    processes = []

    # get config
    config_file = "ttsam_config.json"
    try:
        config = json.load(open(config_file, "r"))
        logger.info(f"{config_file} loaded")
    except FileNotFoundError:
        config = {
            "mqtt": {
                "username": "ttsam",
                "password": "ttsam",
                "host": "0.0.0.0",
                "port": 1883,
                "topic": "ttsam",
            },
            "discord": {
                "webhook_url": "webhook",
                "proxies": {"http": "proxy", "https": "proxy"},
            },
        }
        logger.warning(f"{config_file} not found, using default config")

    # 配置日誌設置
    logger.remove()
    logger.add(sys.stderr, level=args.verbose_level, backtrace=True, diagnose=True)
    logger.add(
        "/workspace/logs/ttsam_error.log",
        rotation="1 week",
        level=args.log_level,
        enqueue=True,
        backtrace=True,
    )

    earthworm_param = {
        "test": {
            "inst_id": 255,
            "wave": {"WAVE_RING_CWASN": 1000, "WAVE_RING_TSMIP": 1030},
            "pick": {"PICK_RING": 1005},
            "eew": {"EEW_RING": 1035},
        },
        "jimmy": {
            "inst_id": 255,
            "wave": {"WAVE_RING_TSMIP": 1034},
            "pick": {"PICK_RING": 1005},
            "eew": {},
        },
        "cwa": {
            "inst_id": 52,
            "wave": {"WAVE_RING_TSMIP": 1034},
            "pick": {"PICK_RING": 1005},
            "eew": {},
        },
    }
    ring_order = []  # 新增：追蹤 ring 添加順序
    earthworm = PyEW.EWModule(
        def_ring=1000,
        mod_id=2,
        inst_id=earthworm_param[args.env]["inst_id"],
        hb_time=30,
        db=False,
    )

    # 添加 wave rings（根據 env 動態添加）
    for ring_name, ring_id in earthworm_param[args.env]["wave"].items():
        earthworm.add_ring(ring_id)
        ring_order.append(ring_name)
        buf_ring = len(ring_order) - 1
        processes.append(
            mp.Process(target=earthworm_wave_listener, kwargs={"buf_ring": buf_ring})
        )
        logger.info(f"Added ring{len(ring_order) - 1}: {ring_name} with ID {ring_id}")

    # 添加 pick rings（根據 env 動態添加）
    for ring_name, ring_id in earthworm_param[args.env]["pick"].items():
        earthworm.add_ring(ring_id)
        ring_order.append(ring_name)
        buf_ring = len(ring_order) - 1
        processes.append(
            mp.Process(target=earthworm_pick_listener, kwargs={"buf_ring": buf_ring})
        )
        logger.info(f"Added ring{len(ring_order) - 1}: {ring_name} with ID {ring_id}")

    # # 添加 eew rings（根據 env 動態添加）
    # for ring_name, ring_id in earthworm_param[args.env]["eew"].items():
    #     earthworm.add_ring(ring_id)
    #     ring_order.append(ring_name)
    #     buf_ring = len(ring_order) - 1
    #     processes.append(
    #         mp.Process(target=earthworm_eew_listener,
    #                                 kwargs={"buf_ring": buf_ring})
    #     )
    #     logger.info(
    #         f"Added ring{len(ring_order) - 1}: {ring_name} with ID {ring_id}")

    logger.info(f"{args.env} env, inst_id = {earthworm_param[args.env]['inst_id']}")

    if args.mqtt:
        username = config["mqtt"]["username"]
        password = config["mqtt"]["password"]
        host = config["mqtt"]["host"]
        port = config["mqtt"]["port"]
        topic = config["mqtt"]["topic"]

        mqtt_client = mqtt.Client()
        mqtt_client.username_pw_set(username, password)
        mqtt_client.connect(host=host, port=port)

    processes.append(mp.Process(target=model_inference))
    processes.append(mp.Process(target=reporter))

    if args.discord:
        processes.append(mp.Process(target=send_discord))
    if args.web:
        processes.append(mp.Process(target=web_server))

    for p in processes:
        p.start()
