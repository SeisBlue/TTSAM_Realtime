docker run \
-v $(pwd):/workspace \
-v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro \
-p 0.0.0.0:5000:5000 \
--rm \
--ipc host \
--name tt-sam-cpu \
seisblue/ttsam \
/opt/conda/bin/python3 /workspace/ttsam_realtime.py