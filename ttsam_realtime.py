import argparse
import asyncio
import bisect
import json
import multiprocessing
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
import torch.nn as nn
from discord_webhook import DiscordEmbed, DiscordWebhook
from flask import Flask, render_template, request
from flask_socketio import SocketIO
from loguru import logger
from scipy.signal import detrend, iirfilter, sosfilt, zpk2sos
from scipy.spatial import cKDTree

app = Flask(__name__)
socketio = SocketIO(app)

# 共享物件
manager = multiprocessing.Manager()

wave_buffer = manager.dict()
wave_queue = manager.Queue()

pick_buffer = manager.dict()

event_queue = manager.Queue()
dataset_queue = manager.Queue()

report_queue = manager.Queue()
discord_queue = manager.Queue()

wave_endt = manager.Value("d", 0)
wave_speed_count = manager.Value("i", 0)

"""
Web Server
"""


@app.route("/", methods=["GET"])
def index():
    report_log_dir = "logs/report"
    try:
        files = []
        for f in os.listdir(report_log_dir):
            file_path = os.path.join(report_log_dir, f)
            if (
                f.startswith("report")
                and f.endswith(".log")
                and os.path.isfile(file_path)
            ):
                files.append(f)
        files.sort(
            key=lambda x: os.path.getmtime(os.path.join(report_log_dir, x)),
            reverse=True,
        )
    except FileNotFoundError:
        files = []
    return render_template("index.html", files=files, target=target_dict)


@app.route("/get_file_content")
def get_file_content():
    report_log_dir = "logs/report"
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


@app.route("/trace")
def trace_page():
    return render_template("trace.html")


@app.route("/event")
def event_page():
    return render_template("event.html")


@app.route("/dataset")
def dataset_page():
    return render_template("dataset.html")


@app.route("/intensityMap")
def map_page():
    return render_template("intensityMap.html")


@socketio.on("connect")
def connect_earthworm():
    socketio.emit("connect_init")


def wave_emitter():
    while True:
        wave = wave_queue.get()
        wave_id = join_id_from_dict(wave, order="NSLC")

        if "Z" not in wave_id:
            continue

        wave["waveid"] = wave_id

        wave_packet = {
            "waveid": wave_id,
            "data": wave["data"].tolist(),
        }

        socketio.emit("wave_packet", wave_packet)


def event_emitter():
    while True:
        event_data = event_queue.get()
        if not event_data:
            continue

        socketio.emit("event_data", event_data)


def dataset_emitter():
    while True:
        dataset_data = dataset_queue.get()
        if not dataset_data:
            continue

        socketio.emit("dataset_data", dataset_data)


def web_server():
    threading.Thread(target=wave_emitter).start()
    threading.Thread(target=event_emitter).start()
    threading.Thread(target=dataset_emitter).start()

    if args.web:
        # 開啟 web server
        app.run(host=args.host, port=args.port, use_reloader=False)
        socketio.run(app, debug=True)


"""
Earthworm Wave Listener
"""

# Load site info
site_info_file = "data/site_info.csv"
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


def earthworm_wave_listener():
    while True:
        if not earthworm.mod_sta():
            continue

        wave = earthworm.get_wave(0)
        if not wave:
            continue

        if wave["endt"] < time.time() - 3:
            continue

        if wave["endt"] > time.time() + 1:
            continue

        buffer_time = 30  # 設定緩衝區保留時間
        sample_rate = 100  # 設定取樣率

        # 得到最新的 wave 結束時間
        wave_endt.value = wave["endt"]

        try:
            wave = convert_to_tsmip_legacy_naming(wave)
            wave_id = join_id_from_dict(wave, order="NSLC")
            wave["data"] = wave["data"] * get_wave_constant(wave)

            # 將 wave_id 加入 wave_queue 給 wave_emitter 發送至前端
            if "Z" in wave_id:
                wave_queue.put(wave)

            # add new trace to buffer
            if wave_id not in wave_buffer.keys():
                # wave_buffer 初始化時全部填入 wave 的平均值，確保 demean 時不會被斷點影響
                wave_buffer[wave_id] = wave_array_init(
                    sample_rate, buffer_time, fill_value=np.array(wave["data"]).mean()
                )
            wave_buffer[wave_id] = slide_array(wave_buffer[wave_id], wave["data"])
            wave_speed_count.value += 1
        except Exception as e:
            logger.error("earthworm_wave_process error", e)


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
        logger.error(f"pick_msg parsing error: {pick_msg_column}", e)


def earthworm_pick_listener():
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
            logger.error(f"delete pick error: {pick_id}", e)

        # 取得 pick msg
        pick_msg = earthworm.get_msg(buf_ring=1, msg_type=0)
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
                if args.test_env:
                    pass  # 測試環境使用歷史資料，不跳過
                else:
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
            logger.error("earthworm_pick_listener error:", e)
            continue
        time.sleep(0.00001)


"""
Model Inference
"""
# Load Vs30 grid
vs30_file = "data/Vs30ofTaiwan.csv"
try:
    logger.info(f"Loading {vs30_file}...")
    vs30_table = pd.read_csv(vs30_file)
    tree = cKDTree(vs30_table[["lat", "lon"]])
    logger.info(f"{vs30_file} loaded")
except FileNotFoundError:
    logger.error(f"{vs30_file} not found")

# Load target station
target_file = "data/eew_target.csv"
try:
    logger.info(f"Loading {target_file}...")
    target_df = pd.read_csv(target_file)
    target_dict = target_df.to_dict(orient="records")
    logger.info(f"{target_file} loaded")

except FileNotFoundError:
    logger.error(f"{target_file} not found")


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
        logger.error("signal_processing error:", e)


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
        logger.error("get_vs30 error", e)


def get_station_position(station):
    try:
        latitude, longitude, elevation = site_info.loc[
            (site_info["Station"] == station), ["Latitude", "Longitude", "Elevation"]
        ].values[0]
        return latitude, longitude, elevation
    except Exception as e:
        logger.error(f"get_station_position error: {station}", e)
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
        logger.error("converter error:", e)


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
        logger.error("dataset_batch error:", e)


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


def ttsam_model_predict(tensor):
    model_path = f"model/ttsam_trained_model_11.pt"
    try:
        full_model = get_full_model(model_path)
        weight, sigma, mu = full_model(tensor)
        pga_list = get_average_pga(weight, sigma, mu)

        return pga_list

    except FileNotFoundError:
        logger.error(f"{model_path} not found")

    except Exception as e:
        logger.error("ttsam_model_predict error:", e)


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
        logger.error("calculate_intensity error:", e)


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
        wave_process_rate = wave_speed_count.value / delta

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
    pick_threshold = 5
    log_folder = "logs"
    report_log_file = None
    while True:
        # 小於 3 個測站不觸發模型預測
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
                    f"{log_folder}/report/report_{first_pick_timestring}.log"
                )
                report_log_file = open(report_log_file, "w+")

                pick_log_file = f"{log_folder}/pick/pick_{first_pick_timestring}.log"
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
                pga_list = ttsam_model_predict(tensor)
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
            logger.error("model_inference error:", e)


"""
PyTorch Model
"""

if torch.cuda.is_available():
    device = torch.device("cuda")
    logger.info("Cuda detected, torch using gpu")
else:
    device = torch.device("cpu")
    logger.info("Cuda not detected, torch using cpu")


class LambdaLayer(nn.Module):
    def __init__(self, lambd, eps=1e-4):
        super(LambdaLayer, self).__init__()
        self.lambd = lambd
        self.eps = eps

    def forward(self, x):
        return self.lambd(x) + self.eps


class MLP(nn.Module):
    def __init__(
        self,
        input_shape,
        dims=(500, 300, 200, 150),
        activation=nn.ReLU(),
        last_activation=None,
    ):
        super(MLP, self).__init__()
        if last_activation is None:
            last_activation = activation
        self.dims = dims
        self.first_fc = nn.Linear(input_shape[0], dims[0])
        self.first_activation = activation

        more_hidden = []
        if len(self.dims) > 2:
            for i in range(1, len(self.dims) - 1):
                more_hidden.append(nn.Linear(self.dims[i - 1], self.dims[i]))
                more_hidden.append(nn.ReLU())

        self.more_hidden = nn.ModuleList(more_hidden)

        self.last_fc = nn.Linear(dims[-2], dims[-1])
        self.last_activation = last_activation

    def forward(self, x):
        output = self.first_fc(x)
        output = self.first_activation(output)
        if self.more_hidden:
            for layer in self.more_hidden:
                output = layer(output)
        output = self.last_fc(output)
        output = self.last_activation(output)
        return output


class CNN(nn.Module):
    """
    input_shape -> BatchSize, Channels, Height, Width
    """

    def __init__(
        self,
        input_shape=(-1, 6000, 3),
        activation=nn.ReLU(),
        downsample=1,
        mlp_input=11665,
        mlp_dims=(500, 300, 200, 150),
        eps=1e-8,
    ):
        super(CNN, self).__init__()
        self.input_shape = input_shape
        self.activation = activation
        self.downsample = downsample
        self.mlp_input = mlp_input
        self.mlp_dims = mlp_dims
        self.eps = eps

        self.lambda_layer_1 = LambdaLayer(
            lambda t: t
            / (
                torch.max(
                    torch.max(torch.abs(t), dim=1, keepdim=True).values,
                    dim=2,
                    keepdim=True,
                ).values
                + self.eps
            )
        )
        self.unsqueeze_layer1 = LambdaLayer(lambda t: torch.unsqueeze(t, dim=1))
        self.lambda_layer_2 = LambdaLayer(
            lambda t: torch.log(
                torch.max(torch.max(torch.abs(t), dim=1).values, dim=1).values
                + self.eps
            )
            / 100
        )
        self.unsqueeze_layer2 = LambdaLayer(lambda t: torch.unsqueeze(t, dim=1))
        self.conv2d1 = nn.Sequential(
            nn.Conv2d(1, 8, kernel_size=(1, downsample), stride=(1, downsample)),
            nn.ReLU(),  # 用self.activation會有兩個ReLU
        )
        self.conv2d2 = nn.Sequential(
            nn.Conv2d(8, 32, kernel_size=(16, 3), stride=(1, 3)), nn.ReLU()
        )

        self.conv1d1 = nn.Sequential(nn.Conv1d(32, 64, kernel_size=16), nn.ReLU())
        self.maxpooling = nn.MaxPool1d(2)

        self.conv1d2 = nn.Sequential(nn.Conv1d(64, 128, kernel_size=16), nn.ReLU())
        self.conv1d3 = nn.Sequential(nn.Conv1d(128, 32, kernel_size=8), nn.ReLU())
        self.conv1d4 = nn.Sequential(nn.Conv1d(32, 32, kernel_size=8), nn.ReLU())
        self.conv1d5 = nn.Sequential(nn.Conv1d(32, 16, kernel_size=4), nn.ReLU())
        self.mlp = MLP((self.mlp_input,), dims=self.mlp_dims)

    def forward(self, x):
        output = self.lambda_layer_1(x)
        output = self.unsqueeze_layer1(output)
        scale = self.lambda_layer_2(x)
        scale = self.unsqueeze_layer2(scale)
        output = self.conv2d1(output)
        output = self.conv2d2(output)
        output = torch.squeeze(output, dim=-1)
        output = self.conv1d1(output)
        output = self.maxpooling(output)
        output = self.conv1d2(output)
        output = self.maxpooling(output)
        output = self.conv1d3(output)
        output = self.maxpooling(output)
        output = self.conv1d4(output)
        output = self.conv1d5(output)
        output = torch.flatten(output, start_dim=1)
        output = torch.cat((output, scale), dim=1)
        output = self.mlp(output)

        return output


class PositionEmbeddingVs30(nn.Module):
    """
    # embed station location (latitude, longitude, elevation, Vs30) to vector
    """

    def __init__(
        self,
        wavelengths=((5, 30), (110, 123), (0.01, 5000), (100, 1600)),
        emb_dim=500,
        **kwargs,
    ):
        super(PositionEmbeddingVs30, self).__init__(**kwargs)
        # Format: [(min_lat, max_lat), (min_lon, max_lon), (min_depth, max_depth)]
        self.wavelengths = wavelengths
        self.emb_dim = emb_dim

        min_lat, max_lat = wavelengths[0]
        min_lon, max_lon = wavelengths[1]
        min_depth, max_depth = wavelengths[2]
        min_vs30, max_vs30 = wavelengths[3]
        assert emb_dim % 10 == 0
        lat_dim = emb_dim // 5
        lon_dim = emb_dim // 5
        depth_dim = emb_dim // 10
        vs30_dim = emb_dim // 10

        self.lat_coeff = (
            2
            * np.pi
            * 1.0
            / min_lat
            * ((min_lat / max_lat) ** (np.arange(lat_dim) / lat_dim))
        )
        self.lon_coeff = (
            2
            * np.pi
            * 1.0
            / min_lon
            * ((min_lon / max_lon) ** (np.arange(lon_dim) / lon_dim))
        )
        self.depth_coeff = (
            2
            * np.pi
            * 1.0
            / min_depth
            * ((min_depth / max_depth) ** (np.arange(depth_dim) / depth_dim))
        )
        self.vs30_coeff = (
            2
            * np.pi
            * 1.0
            / min_vs30
            * ((min_vs30 / max_vs30) ** (np.arange(vs30_dim) / vs30_dim))
        )

        lat_sin_mask = np.arange(emb_dim) % 5 == 0
        # 0~emb_dim % 5==0 -> True --> 一堆 True False 的矩陣
        # 共 500 個T F
        lat_cos_mask = np.arange(emb_dim) % 5 == 1
        lon_sin_mask = np.arange(emb_dim) % 5 == 2
        lon_cos_mask = np.arange(emb_dim) % 5 == 3
        depth_sin_mask = np.arange(emb_dim) % 10 == 4
        depth_cos_mask = np.arange(emb_dim) % 10 == 9
        vs30_sin_mask = np.arange(emb_dim) % 10 == 5
        vs30_cos_mask = np.arange(emb_dim) % 10 == 8

        self.mask = np.zeros(emb_dim)
        self.mask[lat_sin_mask] = np.arange(lat_dim)
        # mask 範圍共 1000 個，lat_sin_mask 裡面有 200 個 True
        # 若是 True 就按照順序把 np.arange(lat_dim) 塞進去
        self.mask[lat_cos_mask] = lat_dim + np.arange(lat_dim)
        self.mask[lon_sin_mask] = 2 * lat_dim + np.arange(lon_dim)
        self.mask[lon_cos_mask] = 2 * lat_dim + lon_dim + np.arange(lon_dim)
        self.mask[depth_sin_mask] = 2 * lat_dim + 2 * lon_dim + np.arange(depth_dim)
        self.mask[depth_cos_mask] = (
            2 * lat_dim + 2 * lon_dim + depth_dim + np.arange(depth_dim)
        )
        self.mask[vs30_sin_mask] = (
            2 * lat_dim + 2 * lon_dim + 2 * depth_dim + np.arange(vs30_dim)
        )
        self.mask[vs30_cos_mask] = (
            2 * lat_dim + 2 * lon_dim + 2 * depth_dim + vs30_dim + np.arange(vs30_dim)
        )
        self.mask = self.mask.astype("int32")

    def forward(self, x):
        lat_base = x[:, :, 0:1].to(device) * torch.Tensor(self.lat_coeff).to(device)
        lon_base = x[:, :, 1:2].to(device) * torch.Tensor(self.lon_coeff).to(device)
        depth_base = x[:, :, 2:3].to(device) * torch.Tensor(self.depth_coeff).to(device)
        vs30_base = x[:, :, 3:4] * torch.Tensor(self.vs30_coeff).to(device)

        output = torch.cat(
            [
                torch.sin(lat_base),
                torch.cos(lat_base),
                torch.sin(lon_base),
                torch.cos(lon_base),
                torch.sin(depth_base),
                torch.cos(depth_base),
                torch.sin(vs30_base),
                torch.cos(vs30_base),
            ],
            dim=-1,
        )

        maskk = torch.from_numpy(np.array(self.mask)).long()
        index = (
            (maskk.unsqueeze(0).unsqueeze(0))
            .expand(x.shape[0], 1, self.emb_dim)
            .to(device)
        )
        output = torch.gather(output, -1, index).to(device)
        return output


class TransformerEncoder(nn.Module):
    def __init__(
        self,
        d_model=150,
        nhead=10,
        batch_first=True,
        activation="gelu",
        dropout=0.0,
        dim_feedforward=1000,
    ):
        super(TransformerEncoder, self).__init__()

        self.encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            batch_first=batch_first,
            activation=activation,
            dropout=dropout,
            dim_feedforward=dim_feedforward,
        ).to(device)
        self.transformer_encoder = nn.TransformerEncoder(self.encoder_layer, 6).to(
            device
        )

    def forward(self, x, src_key_padding_mask=None):
        out = self.transformer_encoder(x, src_key_padding_mask=src_key_padding_mask)
        return out


class MDN(nn.Module):
    def __init__(self, input_shape=(150,), n_hidden=20, n_gaussians=5):
        super(MDN, self).__init__()
        self.z_h = nn.Sequential(nn.Linear(input_shape[0], n_hidden), nn.Tanh())
        self.z_weight = nn.Linear(n_hidden, n_gaussians)
        self.z_sigma = nn.Linear(n_hidden, n_gaussians)
        self.z_mu = nn.Linear(n_hidden, n_gaussians)

    def forward(self, x):
        z_h = self.z_h(x)
        weight = nn.functional.softmax(self.z_weight(z_h), -1)
        sigma = torch.exp(self.z_sigma(z_h))
        mu = self.z_mu(z_h)
        return weight, sigma, mu


class FullModel(nn.Module):
    def __init__(
        self,
        model_cnn,
        model_position,
        model_transformer,
        model_mlp,
        model_mdn,
        max_station=25,
        pga_targets=15,
        emb_dim=150,
        data_length=6000,
    ):
        super(FullModel, self).__init__()
        self.data_length = data_length
        self.model_CNN = model_cnn
        self.model_Position = model_position
        self.model_Transformer = model_transformer
        self.model_mlp = model_mlp
        self.model_MDN = model_mdn
        self.max_station = max_station
        self.pga_targets = pga_targets
        self.emb_dim = emb_dim

    def forward(self, data):
        cnn_output = self.model_CNN(
            torch.DoubleTensor(data["waveform"].reshape(-1, self.data_length, 3))
            .float()
            .to(device)
        )
        cnn_output_reshape = torch.reshape(
            cnn_output, (-1, self.max_station, self.emb_dim)
        )
        emb_output = self.model_Position(
            torch.DoubleTensor(data["station"].reshape(-1, 1, data["station"].shape[2]))
            .float()
            .to(device)
        )
        emb_output = emb_output.reshape(-1, self.max_station, self.emb_dim)
        # data[1] 做一個padding mask [batchsize, station number (25)]
        # value: True, False (True: should mask)
        station_pad_mask = data["station"] == 0
        station_pad_mask = torch.all(station_pad_mask, 2)

        pga_pos_emb_output = self.model_Position(
            torch.DoubleTensor(data["target"].reshape(-1, 1, data["target"].shape[2]))
            .float()
            .to(device)
        )
        pga_pos_emb_output = pga_pos_emb_output.reshape(
            -1, self.pga_targets, self.emb_dim
        )
        # data["target"] 做一個padding mask [batchsize, PGA_target (15)]
        # value: True, False (True: should mask)
        # 避免 target position 在self-attention互相影響結果
        target_pad_mask = torch.ones_like(data["target"], dtype=torch.bool)
        target_pad_mask = torch.all(target_pad_mask, 2)

        # concat two mask, [batchsize, station_number+PGA_target (40)]
        # value: True, False (True: should mask)
        pad_mask = torch.cat((station_pad_mask, target_pad_mask), dim=1).to(device)

        add_pe_cnn_output = torch.add(cnn_output_reshape, emb_output)
        transformer_input = torch.cat((add_pe_cnn_output, pga_pos_emb_output), dim=1)
        transformer_output = self.model_Transformer(transformer_input, pad_mask)

        mlp_input = transformer_output[:, -self.pga_targets :, :].to(device)
        mlp_output = self.model_mlp(mlp_input)
        weight, sigma, mu = self.model_MDN(mlp_output)

        return weight, sigma, mu


def get_full_model(model_path):
    emb_dim = 150
    mlp_dims = (150, 100, 50, 30, 10)
    cnn_model = CNN(mlp_input=5665).to(device)
    pos_emb_model = PositionEmbeddingVs30(emb_dim=emb_dim).to(device)
    transformer_model = TransformerEncoder()
    mlp_model = MLP(input_shape=(emb_dim,), dims=mlp_dims).to(device)
    mdn_model = MDN(input_shape=(mlp_dims[-1],)).to(device)
    full_model = FullModel(
        cnn_model,
        pos_emb_model,
        transformer_model,
        mlp_model,
        mdn_model,
        pga_targets=25,
        data_length=3000,
    ).to(device)
    full_model.load_state_dict(
        torch.load(model_path, weights_only=True, map_location=device)
    )

    return full_model


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

            with open(f"/workspace/logs/format_report/text_report_{report['format_time']}.log", "a") as f:
                f.write(format_report + "\n")

            # 報告傳至 Discord
            discord_queue.put(format_report)
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
            logger.error("send_discord error:", e)
            print(e)


if __name__ == "__main__":
    logger.info("TTSAM Realtime Start")
    parser = argparse.ArgumentParser()
    parser.add_argument("--mqtt", action="store_true", help="connect to mqtt broker")
    parser.add_argument("--discord", action="store_true", help="connect to discord bot")
    parser.add_argument("--web", action="store_true", help="run web server")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="web server ip")
    parser.add_argument("--port", type=int, default=5000, help="web server port")
    parser.add_argument(
        "--test-env", action="store_true", help="test environment, inst_id = 255"
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

    # get config
    config_file = "ttsam_config.json"
    logger.info(f"Loading {config_file}...")
    config = json.load(open(config_file, "r"))
    logger.info(f"{config_file} loaded")

    # 配置日誌設置
    logger.remove()
    logger.add(sys.stderr, level=args.verbose_level)
    logger.add(
        "logs/ttsam_error.log",
        rotation="1 week",
        level=args.log_level,
        enqueue=True,
        backtrace=True,
    )

    inst_id = 52  # CWA
    if args.test_env:
        logger.info("test env, inst_id = 255")
        inst_id = 255  # local

    earthworm = PyEW.EWModule(
        def_ring=1034, mod_id=2, inst_id=inst_id, hb_time=30, db=False
    )
    earthworm.add_ring(1034)  # buf_ring 0: Wave ring
    earthworm.add_ring(1005)  # buf_ring 1: Pick ring

    # 初始化 MQTT
    username = config["mqtt"]["username"]
    password = config["mqtt"]["password"]
    host = config["mqtt"]["host"]
    port = config["mqtt"]["port"]
    topic = config["mqtt"]["topic"]

    mqtt_client = mqtt.Client()
    mqtt_client.username_pw_set(username, password)
    if args.mqtt:
        mqtt_client.connect(host=host, port=port)

    processes = []
    functions = [
        earthworm_wave_listener,
        earthworm_pick_listener,
        model_inference,
        reporter,
        web_server,
        send_discord,
    ]

    # 為每個函數創建一個持續運行的 process
    for func in functions:
        p = multiprocessing.Process(target=func)
        processes.append(p)
        p.start()
