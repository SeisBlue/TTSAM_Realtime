docker run -it --rm \
-v $(pwd):/workspace \
--net host \
--name web_server \
-w /workspace/frontend \
seisblue/ttsam-realtime \
/usr/bin/pnpm run dev --host
