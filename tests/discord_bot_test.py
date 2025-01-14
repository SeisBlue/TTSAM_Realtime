import json
import os

from discord_webhook import DiscordWebhook, DiscordEmbed


config_file = "/workspace/ttsam_config.json"
config = json.load(open(config_file, "r"))


webhook_url = config["discord"]["webhook_url"]
# proxies = config["discord"]["proxies"]

# webhook = DiscordWebhook(url=webhook_url, proxies=proxies)
webhook = DiscordWebhook(url=webhook_url)

context = {"title": "Event", "description": "test", "color": "03b2f8"}

embed = DiscordEmbed(**context)
embed.set_timestamp()
webhook.add_embed(embed)
response = webhook.execute()
