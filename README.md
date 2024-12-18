# TT-SAM 即時資料管線

此專案為地震預警模型 [TT-SAM](https://github.com/JasonChang0320/TT-SAM) 的即時資料管線，整合 Earthworm
平台的即時串流波形與 P 波資訊，經過資料前處理、資料轉換、模型震度預測、最後產出震度報告，提供 MQTT
資訊發布與簡易網頁介面呈現，能在地震 P 波後迅速給出指定目標站點之震度推估。

---

![TTSAM_Realtime_Architecture](/TTSAM_Realtime_Architecture.png)

本系統主要包括 4 個主要模組：

- Wave Listener：接收地震波形
- Pick Listener：接收 P 波訊息
- Model Inference：觸發 TT-SAM 模型預測震度
- Web Server：提供可視化界面

---

## 安裝與環境配置

### 系統需求

- [Earthworm](http://www.earthwormcentral.org/)
- MQTT broker [(Mosquitto)](https://mosquitto.org/)
- [Docker](https://www.docker.com/)

### 由 Docker 安裝

1. 下載專案：

```bash
git clone https://github.com/SeisBlue/TTSAM_Realtime.git
```

2. 下載 Docker 映像檔：

```bash
docker pull seisblue/ttsam-realtime
```

Docker 相關操作與 image 自行建置請參考 [Dockerfile 相關文件](docker/README.md)

3. 檢查必需檔案：

- ttsam_config.json (MQTT 設定檔案)
- data/site_info.txt (測站資訊)
- data/eew_target.csv (預測震度位置)
- data/Vs30ofTaiwan.csv (全台 VS30 網格)
- model/ttsam_trained_model_11.pt (TT-SAM 模型參數)

檔案格式請參考 [資料檔案說明](/docs/data.md)

### 更新專案

更新程式碼：

```bash
cd CWA_TTSAM_Realtime
git stash
git pull
```

更新 Docker 映像檔：

```bash
docker pull seisblue/ttsam-realtime
``` 

---

## 快速啟動

### 進入專案目錄：

```bash
cd CWA_TTSAM_Realtime
```

### 複製 Docker run 範本：

```bash
cp docker_run_ttsam.sh run_ttsam.sh
```

### 更改 run_ttsam.sh：

```bash
docker run \
-v $(pwd):/workspace \
-v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro \
--rm \
--ipc host \
--net host \
--name ttsam-cpu \
seisblue/ttsam-realtime \
/opt/conda/bin/python3 /workspace/ttsam_realtime.py --web --mqtt
```

第二個 `-v /opt/Earthworm/run/params`(左邊)改為本地的 Earthworm 資料夾。

ttsam_realtime.py 的所有選項：
- --mqtt: 連接到 MQTT broker。
- --web: 運行網頁伺服器。
- --host: 指定網頁伺服器的 IP 地址（預設：0.0.0.0）。
- --port: 指定網頁伺服器的端口（預設：5000）。
- --test-env: 在測試環境模式下運行（將 inst_id 設置為 255）。
- --verbose-level: 設置詳細級別（選項：ERROR，WARNING，INFO，DEBUG；預設：INFO）。
- --log-level: 設置日誌級別（選項：ERROR，WARNING，INFO，DEBUG；預設：INFO）。


### 複製 MQTT 設定檔範本：

```bash
cp mqtt_config.json ttsam_config.json
```

### 更改 ttsam_config.json：

```json
{
  "mqtt": {
    "username": "ttsam",
    "password": "ttsam",
    "host": "0.0.0.0",
    "port": 1883,
    "topic": "ttsam"
  }
}
```

依照本地的 MQTT 設定更改。

### 啟動系統：

```bash
sh run_ttsam.sh
```

歷史預測震度文字報告會存放在`logs/report/` 目錄，可以由網頁介面查看。

---

## 網頁介面

### 開啟 ssh 通道

```bash
ssh -L 5000:192.168.x.x:5000 user@remote
```

啟動系統後，可在瀏覽器中輸入 `http://127.0.0.1:5000` 進入網頁介面。

目前提供五個頁面：

- history：顯示歷史地震事件
- trace：顯示即時地震波形
- event：顯示地震事件詳細資訊
- dataset：顯示處理後的資料集
- intensityMap：顯示地震震度分佈

---

## 文件列表

- [資料夾結構](docs/folders.md)
- [資料檔案說明](docs/data.md)
- [Docker 文件](docker/README.md)


