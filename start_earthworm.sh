# 以互動模式運行容器來調試
docker run -it --rm \
  --name earthworm \
  -v ${PWD}/params:/opt/earthworm/run/params \
  -v ${PWD}/logs:/opt/earthworm/run/logs \
  -v ${PWD}/wavefile:/opt/earthworm/wavefile \
 --ipc shareable \
  seisblue/earthworm bash -c "source /opt/Earthworm/run/params/ew_linux.bash && exec bash"