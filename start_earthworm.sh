docker run -it --rm \
  --name earthworm \
  -v ${PWD}/params:/opt/earthworm/run/params \
  -v ${PWD}/logs:/opt/earthworm/run/logs \
  -v ${PWD}/wavefile:/opt/earthworm/wavefile \
 --ipc shareable \
  seisblue/ttsam-realtime bash -c "source /opt/earthworm/run/params/ew_linux.bash && exec bash"
