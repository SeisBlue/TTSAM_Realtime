## Docker

---

### 執行 Docker 容器

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

- -v $(pwd):/workspace - 將本地目錄掛載到容器的 /workspace 目錄。
- -v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro - 將 Earthworm 資料夾掛載到容器的 /opt/Earthworm/run/params 目錄，並設置為唯讀。
- --rm - 結束容器後自動刪除。
- --ipc host - 使用主機的 IPC 通道。
- --net host - 使用主機的網絡。
- --name ttsam-cpu - 容器名稱。
- seisblue/ttsam-realtime - Docker Image 名稱。
- /opt/conda/bin/python3 /workspace/ttsam_realtime.py --web --mqtt - 執行容器中的命令。

---

### 進入容器

```bash
docker exec -it ttsam-cpu /bin/bash
```
