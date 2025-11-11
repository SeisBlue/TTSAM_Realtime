docker run \
-it \
--rm \
-v $(pwd):/workspace \
--ipc host \
--net host \
--name earthworm \
cwadayi/earthworm_ubuntu22.04_eew:v1 bash -c "source /opt/earthworm/ew_linux.bash && exec bash"