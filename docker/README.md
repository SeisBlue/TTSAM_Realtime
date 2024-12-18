# Dockerfile 相關文件

## Pull the Docker image:
```sh
docker pull seisblue/ttsam
```

## Building the Docker Image

```bash
cd CWA_TTSAM_Realtime
docker build -t ttsam:latest -f docker/Dockerfile .
```

## Running the Docker Container

```bash
docker run \
-v $(pwd):/workspace \
-v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro \
--rm \
--ipc host \
--net host \
--name tt-sam-cpu \
seisblue/ttsam \
/opt/conda/bin/python3 /workspace/ttsam_realtime.py [options]
```
## Accessing the Container

```bash
docker exec -it tt-sam-cpu /bin/bash
```

## Stopping the Container

```bash
docker stop tt-sam-cpu
```

## Removing the Container

```bash
docker rm tt-sam-cpu
```
