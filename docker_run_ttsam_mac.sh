docker run \
-v $(pwd):/workspace \
-v /Users/jimmy/earthworm/params:/opt/Earthworm/run/params:ro \
--rm \
-p 5001:5001 \
--ipc=container:earthworm \
--name ttsam-cpu \
seisblue/ttsam-realtime \
/opt/conda/bin/python3 /workspace/ttsam_realtime.py --web --test-env