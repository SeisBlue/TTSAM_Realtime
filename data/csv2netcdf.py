import pandas as pd
import xarray as xr

# 讀取 CSV
df = pd.read_csv('data/Vs30ofTaiwan.csv')

# 取得規則網格的 x, y
x_unique = sorted(df['x'].unique())
y_unique = sorted(df['y'].unique())

# 建立 Dataset
ds = xr.Dataset({
    'vs30': (['y', 'x'], df.pivot(index='y', columns='x', values='Vs30').values),
    # TWD97 座標（2D 陣列）
    'x_twd97': (['y', 'x'], df.pivot(index='y', columns='x', values='x_97').values),
    'y_twd97': (['y', 'x'], df.pivot(index='y', columns='x', values='y_97').values),
    # WGS84 經緯度（2D 陣列）
    'lon': (['y', 'x'], df.pivot(index='y', columns='x', values='lon').values),
    'lat': (['y', 'x'], df.pivot(index='y', columns='x', values='lat').values)
}, coords={
    'x': x_unique,
    'y': y_unique
})

# 加入 metadata 和投影資訊
ds.attrs['crs_grid'] = 'Unknown grid coordinate'
ds.attrs['crs_twd97'] = 'EPSG:3826'  # TWD97 TM2
ds.attrs['crs_wgs84'] = 'EPSG:4326'  # WGS84

ds['vs30'].attrs['long_name'] = 'Vs30'
ds['vs30'].attrs['units'] = 'm/s'

ds['x_twd97'].attrs['long_name'] = 'TWD97 X coordinate'
ds['x_twd97'].attrs['units'] = 'meters'
ds['x_twd97'].attrs['crs'] = 'EPSG:3826'

ds['y_twd97'].attrs['long_name'] = 'TWD97 Y coordinate'
ds['y_twd97'].attrs['units'] = 'meters'
ds['y_twd97'].attrs['crs'] = 'EPSG:3826'

ds['lon'].attrs['long_name'] = 'Longitude'
ds['lon'].attrs['units'] = 'degrees_east'
ds['lon'].attrs['crs'] = 'EPSG:4326'

ds['lat'].attrs['long_name'] = 'Latitude'
ds['lat'].attrs['units'] = 'degrees_north'
ds['lat'].attrs['crs'] = 'EPSG:4326'

# 儲存
ds.to_netcdf('data/Vs30ofTaiwan.nc', format='NETCDF4', engine='netcdf4')
