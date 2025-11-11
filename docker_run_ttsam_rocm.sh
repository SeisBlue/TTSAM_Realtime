docker rm -f ttsam-rocm
docker run \
-v $(pwd):/workspace \
-v $(pwd)/params_cwa:/opt/Earthworm/run/params:ro \
--rm \
--device=/dev/kfd \
--device=/dev/dri \
--group-add video \
--ipc host \
--net host \
--name ttsam-rocm \
seisblue/ttsam-rocm \
python /workspace/ttsam_realtime.py --web --env test
