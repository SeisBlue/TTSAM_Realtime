docker run \
-v $(pwd):/workspace \
-v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro \
--rm \
--ipc host \
--net host \
--name ttsam-cpu \
seisblue/ttsam-realtime \
/opt/conda/bin/python3 $@