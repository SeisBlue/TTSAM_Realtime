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
    """生成模擬波形資料 - 模擬真實網路塞車情況
    某些測站可能累積好幾秒後才一次送達，完全不可預測的更新模式"""
    logger.info("🌊 Starting wave generator with realistic network simulation...")
    logger.info(f"📊 Using {len(target_dict)} target stations from eew_target.csv")

    # 從 target_dict 提取測站代碼
    stations = [station["station"] for station in target_dict]
    logger.info(f"📍 Loaded stations: {', '.join(stations[:5])}... (total {len(stations)})")

    packet_count = 0

    # 為每個測站維護獨立的資料佇列和網路狀態
    station_queues = {station: [] for station in stations}
    station_network_state = {
        station: {
            "congestion_level": random.uniform(0, 0.3),  # 0=暢通, 1=嚴重塞車（大部分測站網路良好）
            "burst_probability": random.uniform(0.6, 0.9),  # 爆發傳輸機率（提高傳輸機率）
            "accumulated_packets": 0,  # 累積的封包數
            "last_send_time": time.time()
        }
        for station in stations
    }

    def generate_waveform_packet():
        """生成單秒波形封包"""
        t = np.linspace(0, 1, 100)
        p_arrival = random.uniform(0.1, 0.3)
        s_arrival = random.uniform(0.4, 0.7)

        wave_data = (
            np.where(t >= p_arrival,
                     np.exp(-(t - p_arrival) / 0.2) * np.sin(2 * np.pi * 5 * (t - p_arrival)) * random.uniform(0.5, 2),
                     0) +
            np.where(t >= s_arrival,
                     np.exp(-(t - s_arrival) / 0.3) * np.sin(2 * np.pi * 2 * (t - s_arrival)) * random.uniform(2, 8),
                     0) +
            np.random.randn(100) * 0.3
        )

        pga = np.max(np.abs(wave_data))
        return {
            "waveform": wave_data.tolist(),
            "pga": float(pga),
            "status": "active"
        }

    # 非同步發送執行緒（模擬測站獨立傳輸）
    def station_sender_loop():
        """每個測站獨立決定何時發送累積的資料"""
        while True:
            try:
                current_time = time.time()

                # 隨機選擇一些測站檢查是否要發送（增加檢查數量以提高響應速度）
                check_stations = random.sample(stations, min(random.randint(20, 40), len(stations)))

                for station in check_stations:
                    state = station_network_state[station]
                    queue = station_queues[station]

                    # 決定是否發送（考慮塞車程度、累積封包數、時間間隔）
                    time_since_last = current_time - state["last_send_time"]

                    should_send = False

                    if state["accumulated_packets"] > 0:
                        # 情況 1: 爆發傳輸（累積太多封包後一次送出）
                        if state["accumulated_packets"] >= random.randint(1, 3):  # 降低閾值：累積 1-3 個就可能送出
                            should_send = random.random() < 0.85  # 85% 機率送出（提高傳輸率）

                        # 情況 2: 隨機傳輸（網路狀況好轉）
                        elif random.random() < state["burst_probability"]:
                            should_send = True

                        # 情況 3: 超時強制傳輸（避免累積太久）
                        elif time_since_last > 3:  # 縮短超時時間：3 秒就強制送出
                            should_send = True
                            logger.debug(f"⏰ {station} 強制傳輸 ({state['accumulated_packets']} 個累積封包)")

                    if should_send and queue:
                        # 一次送出累積的所有封包（延遲補償）
                        burst_size = len(queue)

                        # 依序發送每個累積的封包（從舊到新）
                        # 使用封包自己記錄的生成時間戳
                        for packet_with_timestamp in queue:
                            packet_data = packet_with_timestamp["data"]
                            packet_timestamp = packet_with_timestamp["timestamp"]

                            # 使用 SEED 格式：SM.{station}.01.HLZ
                            seed_station = f"SM.{station}.01.HLZ"
                            wave_packet = {
                                "waveid": f"{seed_station}_{packet_timestamp}",
                                "timestamp": packet_timestamp,
                                "data": {seed_station: packet_data}
                            }

                            socketio.emit("wave_packet", wave_packet)

                        # 清空佇列
                        station_queues[station] = []
                        state["accumulated_packets"] = 0
                        state["last_send_time"] = current_time

                        if burst_size > 1:
                            # 計算實際延遲時間
                            first_packet_time = queue[0]["timestamp"] / 1000
                            delay_seconds = current_time - first_packet_time
                            logger.debug(f"💥 {station} burst send: {burst_size} packets (delay: {delay_seconds:.1f}s, filling gap)")

                # 隨機短暫休息（100-300ms）模擬非同步傳輸
                time.sleep(random.uniform(0.1, 0.3))

            except Exception as e:
                logger.error(f"❌ Station sender error: {e}")
                time.sleep(0.5)

    # 啟動非同步發送執行緒
    threading.Thread(target=station_sender_loop, daemon=True).start()
    logger.info("🚀 Started asynchronous station sender thread")

    # 主迴圈：每秒為所有測站生成資料並加入佇列
    while True:
        try:
            packet_count += 1
            generation_time = time.time()  # 記錄這一輪的生成時間

            # 為每個測站生成新的波形資料並加入佇列
            for station in stations:
                packet = generate_waveform_packet()
                # 將封包與生成時間一起存入佇列
                station_queues[station].append({
                    "data": packet,
                    "timestamp": int(generation_time * 1000)  # 記錄生成時的時間戳
                })
                station_network_state[station]["accumulated_packets"] += 1

            # 每 10 秒記錄一次狀態
            if packet_count % 10 == 0:
                congested_stations = [s for s in stations if station_network_state[s]["accumulated_packets"] > 3]
                avg_queue = np.mean([station_network_state[s]["accumulated_packets"] for s in stations])
                logger.info(f"📈 Generated {packet_count} waves | Avg queue: {avg_queue:.1f} | Congested: {len(congested_stations)}/{len(stations)}")

            # 每 20 秒隨機調整網路狀況（只影響少數測站）
            if packet_count % 20 == 0:
                # 隨機選擇 2-5 個測站（而非 5-15 個）
                affected_stations = random.sample(stations, min(random.randint(2, 5), len(stations)))
                for station in affected_stations:
                    state = station_network_state[station]
                    # 大部分時候保持良好網路（0-0.4），偶爾塞車（0.4-0.8）
                    state["congestion_level"] = random.uniform(0, 0.6)
                    state["burst_probability"] = random.uniform(0.5, 0.9)  # 保持較高的傳輸機率
                logger.debug(f"🔄 Updated network conditions for {len(affected_stations)} stations")

            # 模擬每秒生成資料
            time.sleep(1.0)

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
    logger.info("   - Wave packets: Realistic network congestion simulation 🌐")
    logger.info("     * Each station generates 1 packet/second (100 samples @ 100Hz)")
    logger.info("     * Packets accumulate in queue during congestion")
    logger.info("     * Burst transmission: 2-5 packets sent together with correct timestamps")
    logger.info("     * Delay compensation: backfills missing time periods when burst arrives")
    logger.info("     * Asynchronous delivery: stations send independently")
    logger.info("     * NO predictable update cycle - fully dynamic!")
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

