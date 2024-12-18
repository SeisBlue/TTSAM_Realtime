# 資料夾結構

.github/ - 包含 GitHub 相關文件。
- workflow/ - GitHub Actions 相關文件，用於自動化項目的測試和部署。
  - docker_image_TTSAM.yml - 用於自動化構建 Docker Image 的 GitHub Actions 文件。

data/ - 存儲項目使用的數據集和相關文件。
- eew_target.csv - (必要檔案)預測輸出測站位置，目前為 PWS 參考點測站，可以自由增減。
- site_info.csv - (必要檔案)測站的座標與儀器參數。
- Vs30ofTaiwan.csv - (必要檔案)全台灣 Vs30 格點。 
- read_stationxml.py - 將 StationXML 轉成 site_info.csv。

docker/ - 包含用於容器化應用程序的 Docker 相關文件。
- conda_requirements.txt - 用於創建 Conda 環境的依賴文件。
- Dockerfile - 用於構建 Docker Image 的 Docker 文件。
- requirements.txt - 用於創建 Python 環境的依賴文件。

docs/ - 項目的文檔文件。
- README.md - 項目的主要文檔文件。

logs/ - 應用程序生成的日誌文件目錄。
- pick/ - 存儲地震事件挑選的日誌文件。
- report/ - 存儲地震事件報告的日誌文件。

model/ - 存儲機器學習模型和相關文件。
- ttsam_trained_model_11.pt - (必要檔案)預訓練模型。

templates/ - flask 網頁模板。
- dataset.html - 首頁模板。
- event.html - 地震事件模板。
- index.html - 地震事件列表模板。
- intensityMap.html - 網頁地圖模板。
- trace.html - 地震波形模板。

tests/ - 測試用例和測試腳本目錄。
- data/ 測試用範例檔案

docker_run_ttsam.sh - 用於運行 Docker 容器的腳本。

ttsam_config.py - 項目配置文件。

ttsam_realtime.py - 主要應用程序文件。
