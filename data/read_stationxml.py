from obspy import read_inventory
import pandas as pd

# Read the StationXML file
inventory = read_inventory("data/CWASN_TSMIP.xml")

# 建立列表儲存結果
data = []

for network in inventory.networks:
    for station in network.stations:
        for channel in station.channels:
            try:
                row = {
                    "Station": station.code,
                    "Channel": channel.code,
                    "Location": channel.location_code,
                    "Latitude": channel.latitude,
                    "Longitude": channel.longitude,
                    "Elevation": channel.elevation,
                    "Depth": channel.depth,
                    "Start_time": channel.start_date.strftime("%Y-%m-%d"),
                    "End_time": (
                        channel.end_date.strftime("%Y-%m-%d")
                        if channel.end_date
                        else "2599-12-31"
                    ),
                    "Constant": 1 / channel.response.instrument_sensitivity.value,
                }
                data.append(row)
            except Exception as e:
                print(f"Error: {e}")
                continue
# 轉成 DataFrame
df = pd.DataFrame(data)

# 輸出為 CSV 或檢視
df.to_csv("site_info.csv", index=False)
print(df)
