# Dockerfile 相關文件

## 下載 Docker image:
```sh
docker pull seisblue/ttsam-realtime
```

## 建立 Docker Image

```bash
cd CWA_TTSAM_Realtime
docker build -t ttsam-realtime:latest -f docker/Dockerfile .
```

## 執行 ttsam 主程式

```bash
docker run \
-v $(pwd):/workspace \
-v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro \
--rm \
--ipc host \
--net host \
--name ttsam-cpu \
seisblue/ttsam-realtime \
/opt/conda/bin/python3 /workspace/ttsam_realtime.py [options]
```
- -v $(pwd):/workspace - 將本地目錄掛載到容器的 /workspace 目錄。
- -v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro - 將 Earthworm 資料夾掛載到容器的 /opt/Earthworm/run/params 目錄，並設置為唯讀。
- --rm - 結束容器後自動刪除。
- --ipc host - 使用主機的 IPC 通道。
- --net host - 使用主機的網絡。
- --name ttsam-cpu - 容器名稱。
- seisblue/ttsam-realtime - Docker Image 名稱。
- /opt/conda/bin/python3 /workspace/ttsam_realtime.py --web --mqtt - 執行容器中的命令。

## 進入 Container 內部除錯

```bash
docker exec -it ttsam-cpu /bin/bash
```

## 停止 Container

```bash
docker stop ttsam-cpu
```

## 刪除 Container

```bash
docker rm ttsam-cpu
```

## 刪除 Image

```bash
docker rmi seisblue/ttsam-realtime
```
