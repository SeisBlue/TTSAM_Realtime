docker run \
-v $(pwd):/workspace \
-v /opt/earthworm/run/params:/opt/earthworm/run/params:ro \
--rm \
--ipc host \
--net host \
--name ttsam-cpu \
seisblue/ttsam-realtime \
/opt/conda/bin/python3 /workspace/ttsam_realtime.py --web --env test