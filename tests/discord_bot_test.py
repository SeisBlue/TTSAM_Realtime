import json
import discord
from discord.ext import commands

config_file = "/workspace/ttsam_config.json"
config = json.load(open(config_file, "r"))

# 初始化 Bot
intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)

CHANNEL_ID = config["discord"]["channel_id"]

@bot.event
async def on_ready():
    print(f'機器人已登入為 {bot.user}')
    channel = bot.get_channel(CHANNEL_ID)  # 獲取目標頻道
    if channel:
        await channel.send("你好，這是測試訊息！")  # 傳送訊息
    else:
        print("無法找到頻道，請檢查 CHANNEL_ID 是否正確")


@bot.command()
async def send_file(ctx):
    try:
        # 要傳送的檔案路徑
        file_path = "docker/requirements.txt"
        # 傳送檔案
        await ctx.send(file=discord.File(file_path))
        await ctx.send("檔案已成功傳送！")
    except Exception as e:
        await ctx.send(f"傳送失敗：{e}")


# 啟動 Bot
bot.run(config["discord"]["token"])
