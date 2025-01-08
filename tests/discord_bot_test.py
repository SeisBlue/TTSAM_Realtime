import asyncio
import json
import os
from multiprocessing import Process, Queue

import discord
from discord.ext import commands

# 載入設定檔案
config_file = "/workspace/ttsam_config.json"
if not os.path.exists(config_file):
    print(f"配置檔案 {config_file} 不存在")
    exit(1)

try:
    config = json.load(open(config_file, "r"))
except json.JSONDecodeError:
    print(f"配置檔案 {config_file} 格式有誤！")
    exit(1)

# 目標頻道 ID 和 Token
CHANNEL_ID = config.get("discord", {}).get("channel_id")
TOKEN = config.get("discord", {}).get("token")

if not CHANNEL_ID or not TOKEN:
    print("請確認配置檔案中已設定 'channel_id' 與 'token'")
    exit(1)


# Discord Bot 子程序
def bot_process(queue):
    intents = discord.Intents.default()
    intents.message_content = True
    bot = commands.Bot(command_prefix="!", intents=intents)

    @bot.event
    async def on_ready():
        print(f"機器人已登入為 {bot.user}")
        channel = bot.get_channel(CHANNEL_ID)
        if channel:
            await channel.send("你好，這是機器人已啟動的訊息！")
        else:
            print("無法找到頻道，請檢查 CHANNEL_ID 是否正確")

    async def send_message(bot, message):
        channel = bot.get_channel(CHANNEL_ID)
        if channel:
            await channel.send(message)
        else:
            print("無法找到頻道，請檢查 CHANNEL_ID 是否正確")

    async def listen_for_messages(queue):
        while True:
            if not queue.empty():
                try:
                    message = queue.get_nowait()
                    if message == "exit":
                        print("關閉機器人...")
                        await bot.close()
                        break
                    else:
                        await send_message(bot, message)
                except Exception as e:
                    print(f"錯誤發生：{e}")
            await asyncio.sleep(0.1)  # 避免效能消耗過大

    async def start():
        bot_task = asyncio.create_task(bot.start(TOKEN))
        listen_task = asyncio.create_task(listen_for_messages(queue))
        await asyncio.gather(bot_task, listen_task)

    loop = asyncio.get_event_loop()
    loop.run_until_complete(start())


# 主程式
def main():
    queue = Queue()
    p = Process(target=bot_process, args=(queue,))
    p.start()
    print("主程式已啟動。輸入訊息以傳送到 Discord (輸入 'exit' 來結束):")
    while True:
        msg = input("> ")
        if msg.lower() == "exit":
            queue.put("exit")
            break
        queue.put(msg)
    p.join()
    print("主程式結束。")


if __name__ == "__main__":
    main()
