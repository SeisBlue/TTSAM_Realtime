docker run --rm \
-v $(pwd):/workspace \
--ipc host \
--net host \
--name web_server \
-w /workspace/frontend \
seisblue/ttsam-realtime \
/bin/bash pnpm run dev --host