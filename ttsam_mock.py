#!/usr/bin/env python3
"""
TTSAM Mock Server
用於前端開發測試，不依賴 Earthworm 和 PyEarthworm
"""

import json
import os
import random
import threading
import time
from datetime import datetime

import numpy as np
import pandas as pd
from flask import Flask, render_template, request
from flask_socketio import SocketIO
from flask_cors import CORS
from loguru import logger

# ========== Flask App Setup ==========
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*")

# ========== Load Target Stations ==========
target_file = "data/eew_target.csv"
try:
    logger.info(f"Loading {target_file}...")
    target_df = pd.read_csv(target_file)
    target_dict = target_df.to_dict(orient="records")
    logger.success(f"✅ Loaded {len(target_dict)} target stations")
except FileNotFoundError:
    logger.warning(f"❌ {target_file} not found, using dummy data")
    target_dict = [
        {"station": "MOCK1", "station_zh": "模擬站1", "county": "台北市", "lat": 25.0, "lon": 121.5},
        {"station": "MOCK2", "station_zh": "模擬站2", "county": "新北市", "lat": 25.1, "lon": 121.6},
        {"station": "MOCK3", "station_zh": "模擬站3", "county": "桃園市", "lat": 24.9, "lon": 121.3},
    ]

# ========== Web Routes ==========
@app.route("/", methods=["GET"])
def index():
    """首頁 - 顯示報告清單"""
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
        logger.warning(f"❌ {report_log_dir} not found")

    return render_template("index.html", files=files, target=target_dict)


@app.route("/get_file_content")
def get_file_content():
    """取得報告檔案內容"""
    report_log_dir = "logs/report"
    file_name = request.args.get("file")

    # 安全性檢查
    if not file_name.startswith("report"):
        return "Invalid file type", 400
    if not file_name.endswith(".log"):
        return "Invalid file type", 400
    if ".." in file_name or "/" in file_name or "\\" in file_name:
        return "Invalid file name", 400

    try:
        file_path = os.path.join(report_log_dir, file_name)
        with open(file_path, "r", encoding="utf-8") as file:
            content = file.read()
        return content
    except Exception as e:
        logger.error(f"❌ Error reading file: {e}")
        return str(e), 500


@app.route("/api/stations")
def get_stations():
    """API: 取得測站列表（JSON格式）"""
    try:
        return json.dumps(target_dict, ensure_ascii=False), 200, {'Content-Type': 'application/json; charset=utf-8'}
    except Exception as e:
        logger.error(f"❌ Error getting stations: {e}")
        return json.dumps({"error": str(e)}), 500, {'Content-Type': 'application/json; charset=utf-8'}


@app.route("/trace")
def trace_page():
    """波形頁面"""
    return render_template("trace.html")


@app.route("/event")
def event_page():
    """事件頁面"""
    return render_template("event.html")


@app.route("/dataset")
def dataset_page():
    """資料集頁面"""
    return render_template("dataset.html")


@app.route("/intensityMap")
def map_page():
    """震度地圖頁面"""
    return render_template("intensityMap.html")


@socketio.on("connect")
def handle_connect():
    """客戶端連線"""
    logger.info("🔌 Client connected")
    socketio.emit("connect_init")


# ========== Mock Data Generators ==========

def generate_mock_wave():
    """生成模擬波形資料 - 使用 eew_target.csv 測站（約 48 站）"""
    logger.info("🌊 Starting wave generator with target stations...")
    logger.info(f"📊 Using {len(target_dict)} target stations from eew_target.csv")

    # 從 target_dict 提取測站代碼
    stations = [station["station"] for station in target_dict]
    logger.info(f"📍 Loaded stations: {', '.join(stations[:5])}... (total {len(stations)})")

    packet_count = 0

    while True:
        try:
            # 每輪隨機選擇 10-20 個測站發送波形
            num_stations = random.randint(10, 20)
            selected_stations = random.sample(stations, min(num_stations, len(stations)))

            # 建立批次封包（前端期望的格式）
            wave_packet = {
                "waveid": f"batch_{int(time.time() * 1000)}",
                "timestamp": int(time.time() * 1000),
                "data": {}
            }

            for station in selected_stations:
                # 生成隨機波形（1 秒，100 個點 @ 100Hz）
                t = np.linspace(0, 1, 100)

                # 模擬地震波：P波 + S波 + 噪音
                p_arrival = random.uniform(0.2, 0.4)
                s_arrival = random.uniform(0.5, 0.7)

                wave_data = (
                    # P波（縱波，較小振幅）
                    np.where(t >= p_arrival,
                             np.exp(-(t - p_arrival) / 0.2) * np.sin(2 * np.pi * 5 * (t - p_arrival)) * random.uniform(0.5, 2),
                             0) +
                    # S波（橫波，較大振幅）
                    np.where(t >= s_arrival,
                             np.exp(-(t - s_arrival) / 0.3) * np.sin(2 * np.pi * 2 * (t - s_arrival)) * random.uniform(2, 8),
                             0) +
                    # 背景噪音
                    np.random.randn(100) * 0.2
                )

                # 計算 PGA（峰值地動加速度）
                pga = np.max(np.abs(wave_data))

                wave_packet["data"][station] = {
                    "waveform": wave_data.tolist(),
                    "pga": float(pga),
                    "status": "active"
                }

            # 發送批次封包
            socketio.emit("wave_packet", wave_packet)
            packet_count += 1

            # 每 10 個封包記錄一次
            if packet_count % 10 == 0:
                logger.info(f"📈 Sent {packet_count} wave packets (latest: {len(selected_stations)} stations)")

            # 間隔 2 秒（模擬每 2 秒更新）
            time.sleep(2)

        except Exception as e:
            logger.error(f"❌ Wave generator error: {e}")
            time.sleep(1)


def generate_mock_event():
    """生成模擬地震事件"""
    logger.info("📍 Starting event generator...")
    time.sleep(5)  # 等待 5 秒後開始

    event_count = 0

    while True:
        try:
            event_count += 1
            num_stations = random.randint(3, 8)  # 3-8 個測站觸發
            stations = random.sample(["HL1A", "NACB", "CHY1", "TAP1", "NCU1", "TPUB", "KAU1"], num_stations)

            event_data = {}

            for station in stations:
                # 生成三軸波形（3000 點 = 30 秒 @ 100Hz）
                t = np.linspace(0, 30, 3000)

                # P 波到達（模擬地震波形）
                p_arrival = random.uniform(2, 5)
                s_arrival = p_arrival + random.uniform(3, 8)

                def seismic_wave(t, arrival_time, amplitude):
                    """模擬地震波"""
                    wave = np.zeros_like(t)
                    mask = t >= arrival_time
                    wave[mask] = amplitude * np.exp(-(t[mask] - arrival_time) / 5) * np.sin(2 * np.pi * 3 * (t[mask] - arrival_time))
                    return wave

                pga = random.uniform(0.5, 8.0)  # 0.5~8.0 gal

                z_wave = (
                    seismic_wave(t, p_arrival, pga * 0.7) +
                    seismic_wave(t, s_arrival, pga * 1.5) +
                    np.random.randn(3000) * 0.3
                )

                n_wave = (
                    seismic_wave(t, s_arrival, pga * 1.2) +
                    np.random.randn(3000) * 0.3
                )

                e_wave = (
                    seismic_wave(t, s_arrival, pga * 1.0) +
                    np.random.randn(3000) * 0.3
                )

                event_data[f"SM.{station}.01.HLZ"] = {
                    "pick": {
                        "station": station,
                        "pick_time": str(time.time()),
                        "pga": f"{pga:.2f}",
                        "intensity": str(random.randint(1, 5))
                    },
                    "trace": {
                        "Z": z_wave.tolist(),
                        "N": n_wave.tolist(),
                        "E": e_wave.tolist(),
                    }
                }

            logger.info(f"📡 Emitting event #{event_count} with {len(event_data)} stations")
            socketio.emit("event_data", event_data)

            # 隨機間隔 10-30 秒
            time.sleep(random.uniform(10, 15))

        except Exception as e:
            logger.error(f"❌ Event generator error: {e}")
            time.sleep(5)


def generate_mock_dataset():
    """生成模擬預測資料集"""
    logger.info("📊 Starting dataset generator...")
    time.sleep(8)  # 等待 8 秒後開始

    dataset_count = 0

    while True:
        try:
            dataset_count += 1

            # 隨機選擇觸發測站
            source_stations = random.sample(["HL1A", "NACB", "CHY1"], random.randint(1, 3))

            # 預測目標測站（從 target_dict 選取）
            num_targets = min(len(target_dict), random.randint(10, 30))
            target_stations = random.sample(target_dict, num_targets)

            # 生成預測資料
            target_names = [t["station"] for t in target_stations]
            pga_values = [random.uniform(0.1, 10.0) for _ in range(num_targets)]

            # 震度計算（簡化版）
            def pga_to_intensity(pga):
                if pga < 0.8:
                    return 0
                elif pga < 2.5:
                    return 1
                elif pga < 8.0:
                    return 2
                elif pga < 25:
                    return 3
                elif pga < 80:
                    return 4
                elif pga < 250:
                    return 5
                elif pga < 400:
                    return 6
                else:
                    return 7

            intensity_values = [pga_to_intensity(pga) for pga in pga_values]

            dataset = {
                "station_name": source_stations,
                "target_name": target_names,
                "pga": pga_values,
                "intensity": intensity_values
            }

            logger.info(f"📈 Emitting dataset #{dataset_count} with {num_targets} targets")
            socketio.emit("dataset_data", dataset)

            # 隨機間隔 15-30 秒
            time.sleep(random.uniform(15, 30))

        except Exception as e:
            logger.error(f"❌ Dataset generator error: {e}")
            time.sleep(5)


# ========== Main Entry Point ==========

def start_mock_server():
    """啟動 Mock Server"""
    logger.info("=" * 60)
    logger.info("🚀 TTSAM Mock Server Starting...")
    logger.info("=" * 60)
    logger.info("📍 Server will run at: http://0.0.0.0:5001")
    logger.info("🌐 Available pages:")
    logger.info("   - http://localhost:5001/          (首頁)")
    logger.info("   - http://localhost:5001/trace     (波形)")
    logger.info("   - http://localhost:5001/event     (事件)")
    logger.info("   - http://localhost:5001/dataset   (資料集)")
    logger.info("   - http://localhost:5001/intensityMap (震度地圖)")
    logger.info("=" * 60)
    logger.info("📊 Mock data generators will start in background...")
    logger.info("   - Wave packets: 10-20 stations every 2 seconds")
    logger.info("     * Each packet contains waveform + PGA data")
    logger.info("     * Simulated P-wave and S-wave arrivals")
    logger.info("   - Events: every 10-30s")
    logger.info("   - Datasets: every 15-30s")
    logger.info("=" * 60)

    # 啟動模擬資料生成器（背景執行緒）
    threading.Thread(target=generate_mock_wave, daemon=True).start()
    threading.Thread(target=generate_mock_event, daemon=True).start()
    threading.Thread(target=generate_mock_dataset, daemon=True).start()

    # 啟動 Flask + SocketIO server
    socketio.run(
        app,
        host="0.0.0.0",
        port=5001,
        debug=False,  # 避免重複啟動
        use_reloader=False
    )


if __name__ == "__main__":
    start_mock_server()

