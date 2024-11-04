# Dockerfile for TT-SAM environment (CPU version)

## Building the Docker Image

1. Clone the repository:
```sh
git clone 
cd 
```

## Building the Docker Image

```bash
docker build -t ttsam:latest -f CWA_Real_Time/docker/Dockerfile .
```

## Running the Docker Container

```bash
docker run \
-v $(pwd):/workspace \
-v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro \
-p 0.0.0.0:5000:5000 \
--rm \
--ipc host \
--name tt-sam-cpu \
seisblue/ttsam \
/opt/conda/bin/python3 /workspace/ttsam_realtime.py
```
## Accessing the Container


## Stopping the Container



