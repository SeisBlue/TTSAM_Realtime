import argparse
import bisect
import json
import multiprocessing
import threading
import time

import numpy as np
import paho.mqtt.client as mqtt
import pandas as pd
import PyEW
import torch
import torch.nn as nn
from flask import Flask, render_template
from flask_socketio import SocketIO
from scipy.signal import detrend, iirfilter, sosfilt, zpk2sos
from scipy.spatial import cKDTree

if torch.cuda.is_available():
    device = torch.device("cuda")
    print("Cuda detected, torch using gpu")
else:
    device = torch.device("cpu")
    print("Cuda not detected, torch using cpu")


class LambdaLayer(nn.Module):
    def __init__(self, lambd, eps=1e-4):
        super(LambdaLayer, self).__init__()
        self.lambd = lambd
        self.eps = eps

    def forward(self, x):
        return self.lambd(x) + self.eps


class MLP(nn.Module):
    def __init__(
        self,
        input_shape,
        dims=(500, 300, 200, 150),
        activation=nn.ReLU(),
        last_activation=None,
    ):
        super(MLP, self).__init__()
        if last_activation is None:
            last_activation = activation
        self.dims = dims
        self.first_fc = nn.Linear(input_shape[0], dims[0])
        self.first_activation = activation

        more_hidden = []
        if len(self.dims) > 2:
            for i in range(1, len(self.dims) - 1):
                more_hidden.append(nn.Linear(self.dims[i - 1], self.dims[i]))
                more_hidden.append(nn.ReLU())

        self.more_hidden = nn.ModuleList(more_hidden)

        self.last_fc = nn.Linear(dims[-2], dims[-1])
        self.last_activation = last_activation

    def forward(self, x):
        output = self.first_fc(x)
        output = self.first_activation(output)
        if self.more_hidden:
            for layer in self.more_hidden:
                output = layer(output)
        output = self.last_fc(output)
        output = self.last_activation(output)
        return output


class CNN(nn.Module):
    """
    input_shape -> BatchSize, Channels, Height, Width
    """

    def __init__(
        self,
        input_shape=(-1, 6000, 3),
        activation=nn.ReLU(),
        downsample=1,
        mlp_input=11665,
        mlp_dims=(500, 300, 200, 150),
        eps=1e-8,
    ):
        super(CNN, self).__init__()
        self.input_shape = input_shape
        self.activation = activation
        self.downsample = downsample
        self.mlp_input = mlp_input
        self.mlp_dims = mlp_dims
        self.eps = eps

        self.lambda_layer_1 = LambdaLayer(
            lambda t: t
            / (
                torch.max(
                    torch.max(torch.abs(t), dim=1, keepdim=True).values,
                    dim=2,
                    keepdim=True,
                ).values
                + self.eps
            )
        )
        self.unsqueeze_layer1 = LambdaLayer(lambda t: torch.unsqueeze(t, dim=1))
        self.lambda_layer_2 = LambdaLayer(
            lambda t: torch.log(
                torch.max(torch.max(torch.abs(t), dim=1).values, dim=1).values
                + self.eps
            )
            / 100
        )
        self.unsqueeze_layer2 = LambdaLayer(lambda t: torch.unsqueeze(t, dim=1))
        self.conv2d1 = nn.Sequential(
            nn.Conv2d(1, 8, kernel_size=(1, downsample), stride=(1, downsample)),
            nn.ReLU(),  # 用self.activation會有兩個ReLU
        )
        self.conv2d2 = nn.Sequential(
            nn.Conv2d(8, 32, kernel_size=(16, 3), stride=(1, 3)), nn.ReLU()
        )

        self.conv1d1 = nn.Sequential(nn.Conv1d(32, 64, kernel_size=16), nn.ReLU())
        self.maxpooling = nn.MaxPool1d(2)

        self.conv1d2 = nn.Sequential(nn.Conv1d(64, 128, kernel_size=16), nn.ReLU())
        self.conv1d3 = nn.Sequential(nn.Conv1d(128, 32, kernel_size=8), nn.ReLU())
        self.conv1d4 = nn.Sequential(nn.Conv1d(32, 32, kernel_size=8), nn.ReLU())
        self.conv1d5 = nn.Sequential(nn.Conv1d(32, 16, kernel_size=4), nn.ReLU())
        self.mlp = MLP((self.mlp_input,), dims=self.mlp_dims)

    def forward(self, x):
        output = self.lambda_layer_1(x)
        output = self.unsqueeze_layer1(output)
        scale = self.lambda_layer_2(x)
        scale = self.unsqueeze_layer2(scale)
        output = self.conv2d1(output)
        output = self.conv2d2(output)
        output = torch.squeeze(output, dim=-1)
        output = self.conv1d1(output)
        output = self.maxpooling(output)
        output = self.conv1d2(output)
        output = self.maxpooling(output)
        output = self.conv1d3(output)
        output = self.maxpooling(output)
        output = self.conv1d4(output)
        output = self.conv1d5(output)
        output = torch.flatten(output, start_dim=1)
        output = torch.cat((output, scale), dim=1)
        output = self.mlp(output)

        return output


class CnnFeatureMap(nn.Module):
    """
    get cnn feature map to explain feature extraction
    """

    def __init__(
        self,
        input_shape=(-1, 6000, 3),
        activation=nn.ReLU(),
        downsample=1,
        mlp_input=11665,
        mlp_dims=(500, 300, 200, 150),
        eps=1e-8,
    ):
        super(CnnFeatureMap, self).__init__()
        self.input_shape = input_shape
        self.activation = activation
        self.downsample = downsample
        self.mlp_input = mlp_input
        self.mlp_dims = mlp_dims
        self.eps = eps

        self.lambda_layer_1 = LambdaLayer(
            lambda t: t
            / (
                torch.max(
                    torch.max(torch.abs(t), dim=1, keepdim=True).values,
                    dim=2,
                    keepdim=True,
                ).values
                + self.eps
            )
        )
        self.unsqueeze_layer1 = LambdaLayer(lambda t: torch.unsqueeze(t, dim=1))
        self.lambda_layer_2 = LambdaLayer(
            lambda t: torch.log(
                torch.max(torch.max(torch.abs(t), dim=1).values, dim=1).values
                + self.eps
            )
            / 100
        )
        self.unsqueeze_layer2 = LambdaLayer(lambda t: torch.unsqueeze(t, dim=1))
        self.conv2d1 = nn.Sequential(
            nn.Conv2d(1, 8, kernel_size=(1, downsample), stride=(1, downsample)),
            nn.ReLU(),  # 用self.activation會有兩個ReLU
        )
        self.conv2d2 = nn.Sequential(
            nn.Conv2d(8, 32, kernel_size=(16, 3), stride=(1, 3)), nn.ReLU()
        )

        self.conv1d1 = nn.Sequential(nn.Conv1d(32, 64, kernel_size=16), nn.ReLU())
        self.maxpooling = nn.MaxPool1d(2)

        self.conv1d2 = nn.Sequential(nn.Conv1d(64, 128, kernel_size=16), nn.ReLU())
        self.conv1d3 = nn.Sequential(nn.Conv1d(128, 32, kernel_size=8), nn.ReLU())
        self.conv1d4 = nn.Sequential(nn.Conv1d(32, 32, kernel_size=8), nn.ReLU())
        self.conv1d5 = nn.Sequential(nn.Conv1d(32, 16, kernel_size=4), nn.ReLU())
        self.mlp = MLP((self.mlp_input,), dims=self.mlp_dims)

    def forward(self, x):
        layer_output = []
        output = self.lambda_layer_1(x)
        output = self.unsqueeze_layer1(output)
        scale = self.lambda_layer_2(x)
        scale = self.unsqueeze_layer2(scale)
        output = self.conv2d1(output)
        layer_output.append(output)
        output = self.conv2d2(output)
        layer_output.append(output)
        output = torch.squeeze(output, dim=-1)
        output = self.conv1d1(output)
        layer_output.append(output)
        output = self.maxpooling(output)
        output = self.conv1d2(output)
        layer_output.append(output)
        output = self.maxpooling(output)
        output = self.conv1d3(output)
        layer_output.append(output)
        output = self.maxpooling(output)
        output = self.conv1d4(output)
        layer_output.append(output)
        output = self.conv1d5(output)
        layer_output.append(output)
        output = torch.flatten(output, start_dim=1)
        output = torch.cat((output, scale), dim=1)
        output = self.mlp(output)

        return output, layer_output


class PositionEmbeddingVs30(nn.Module):
    """
    # embed station location (latitude, longitude, elevation, Vs30) to vector
    """

    def __init__(
        self,
        wavelengths=((5, 30), (110, 123), (0.01, 5000), (100, 1600)),
        emb_dim=500,
        **kwargs,
    ):
        super(PositionEmbeddingVs30, self).__init__(**kwargs)
        # Format: [(min_lat, max_lat), (min_lon, max_lon), (min_depth, max_depth)]
        self.wavelengths = wavelengths
        self.emb_dim = emb_dim

        min_lat, max_lat = wavelengths[0]
        min_lon, max_lon = wavelengths[1]
        min_depth, max_depth = wavelengths[2]
        min_vs30, max_vs30 = wavelengths[3]
        assert emb_dim % 10 == 0
        lat_dim = emb_dim // 5
        lon_dim = emb_dim // 5
        depth_dim = emb_dim // 10
        vs30_dim = emb_dim // 10

        self.lat_coeff = (
            2
            * np.pi
            * 1.0
            / min_lat
            * ((min_lat / max_lat) ** (np.arange(lat_dim) / lat_dim))
        )
        self.lon_coeff = (
            2
            * np.pi
            * 1.0
            / min_lon
            * ((min_lon / max_lon) ** (np.arange(lon_dim) / lon_dim))
        )
        self.depth_coeff = (
            2
            * np.pi
            * 1.0
            / min_depth
            * ((min_depth / max_depth) ** (np.arange(depth_dim) / depth_dim))
        )
        self.vs30_coeff = (
            2
            * np.pi
            * 1.0
            / min_vs30
            * ((min_vs30 / max_vs30) ** (np.arange(vs30_dim) / vs30_dim))
        )

        lat_sin_mask = np.arange(emb_dim) % 5 == 0
        # 0~emb_dim % 5==0 -> True --> 一堆 True False 的矩陣
        # 共 500 個T F
        lat_cos_mask = np.arange(emb_dim) % 5 == 1
        lon_sin_mask = np.arange(emb_dim) % 5 == 2
        lon_cos_mask = np.arange(emb_dim) % 5 == 3
        depth_sin_mask = np.arange(emb_dim) % 10 == 4
        depth_cos_mask = np.arange(emb_dim) % 10 == 9
        vs30_sin_mask = np.arange(emb_dim) % 10 == 5
        vs30_cos_mask = np.arange(emb_dim) % 10 == 8

        self.mask = np.zeros(emb_dim)
        self.mask[lat_sin_mask] = np.arange(lat_dim)
        # mask 範圍共 1000 個，lat_sin_mask 裡面有 200 個 True
        # 若是 True 就按照順序把 np.arange(lat_dim) 塞進去
        self.mask[lat_cos_mask] = lat_dim + np.arange(lat_dim)
        self.mask[lon_sin_mask] = 2 * lat_dim + np.arange(lon_dim)
        self.mask[lon_cos_mask] = 2 * lat_dim + lon_dim + np.arange(lon_dim)
        self.mask[depth_sin_mask] = 2 * lat_dim + 2 * lon_dim + np.arange(depth_dim)
        self.mask[depth_cos_mask] = (
            2 * lat_dim + 2 * lon_dim + depth_dim + np.arange(depth_dim)
        )
        self.mask[vs30_sin_mask] = (
            2 * lat_dim + 2 * lon_dim + 2 * depth_dim + np.arange(vs30_dim)
        )
        self.mask[vs30_cos_mask] = (
            2 * lat_dim + 2 * lon_dim + 2 * depth_dim + vs30_dim + np.arange(vs30_dim)
        )
        self.mask = self.mask.astype("int32")

    def forward(self, x):
        lat_base = x[:, :, 0:1].to(device) * torch.Tensor(self.lat_coeff).to(device)
        lon_base = x[:, :, 1:2].to(device) * torch.Tensor(self.lon_coeff).to(device)
        depth_base = x[:, :, 2:3].to(device) * torch.Tensor(self.depth_coeff).to(device)
        vs30_base = x[:, :, 3:4] * torch.Tensor(self.vs30_coeff).to(device)

        output = torch.cat(
            [
                torch.sin(lat_base),
                torch.cos(lat_base),
                torch.sin(lon_base),
                torch.cos(lon_base),
                torch.sin(depth_base),
                torch.cos(depth_base),
                torch.sin(vs30_base),
                torch.cos(vs30_base),
            ],
            dim=-1,
        )

        maskk = torch.from_numpy(np.array(self.mask)).long()
        index = (
            (maskk.unsqueeze(0).unsqueeze(0))
            .expand(x.shape[0], 1, self.emb_dim)
            .to(device)
        )
        output = torch.gather(output, -1, index).to(device)
        return output


class TransformerEncoder(nn.Module):
    def __init__(
        self,
        d_model=150,
        nhead=10,
        batch_first=True,
        activation="gelu",
        dropout=0.0,
        dim_feedforward=1000,
    ):
        super(TransformerEncoder, self).__init__()

        self.encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            batch_first=batch_first,
            activation=activation,
            dropout=dropout,
            dim_feedforward=dim_feedforward,
        ).to(device)
        self.transformer_encoder = nn.TransformerEncoder(self.encoder_layer, 6).to(
            device
        )

    def forward(self, x, src_key_padding_mask=None):
        out = self.transformer_encoder(x, src_key_padding_mask=src_key_padding_mask)
        return out


class MDN(nn.Module):
    def __init__(self, input_shape=(150,), n_hidden=20, n_gaussians=5):
        super(MDN, self).__init__()
        self.z_h = nn.Sequential(nn.Linear(input_shape[0], n_hidden), nn.Tanh())
        self.z_weight = nn.Linear(n_hidden, n_gaussians)
        self.z_sigma = nn.Linear(n_hidden, n_gaussians)
        self.z_mu = nn.Linear(n_hidden, n_gaussians)

    def forward(self, x):
        z_h = self.z_h(x)
        weight = nn.functional.softmax(self.z_weight(z_h), -1)
        sigma = torch.exp(self.z_sigma(z_h))
        mu = self.z_mu(z_h)
        return weight, sigma, mu


class FullModel(nn.Module):
    def __init__(
        self,
        model_cnn,
        model_position,
        model_transformer,
        model_mlp,
        model_mdn,
        max_station=25,
        pga_targets=15,
        emb_dim=150,
        data_length=6000,
    ):
        super(FullModel, self).__init__()
        self.data_length = data_length
        self.model_CNN = model_cnn
        self.model_Position = model_position
        self.model_Transformer = model_transformer
        self.model_mlp = model_mlp
        self.model_MDN = model_mdn
        self.max_station = max_station
        self.pga_targets = pga_targets
        self.emb_dim = emb_dim

    def forward(self, data):
        cnn_output = self.model_CNN(
            torch.DoubleTensor(data["waveform"].reshape(-1, self.data_length, 3))
            .float()
            .to(device)
        )
        cnn_output_reshape = torch.reshape(
            cnn_output, (-1, self.max_station, self.emb_dim)
        )
        emb_output = self.model_Position(
            torch.DoubleTensor(data["station"].reshape(-1, 1, data["station"].shape[2]))
            .float()
            .to(device)
        )
        emb_output = emb_output.reshape(-1, self.max_station, self.emb_dim)
        # data[1] 做一個padding mask [batchsize, station number (25)]
        # value: True, False (True: should mask)
        station_pad_mask = data["station"] == 0
        station_pad_mask = torch.all(station_pad_mask, 2)

        pga_pos_emb_output = self.model_Position(
            torch.DoubleTensor(data["target"].reshape(-1, 1, data["target"].shape[2]))
            .float()
            .to(device)
        )
        pga_pos_emb_output = pga_pos_emb_output.reshape(
            -1, self.pga_targets, self.emb_dim
        )
        # data["target"] 做一個padding mask [batchsize, PGA_target (15)]
        # value: True, False (True: should mask)
        # 避免 target position 在self-attention互相影響結果
        target_pad_mask = torch.ones_like(data["target"], dtype=torch.bool)
        target_pad_mask = torch.all(target_pad_mask, 2)

        # concat two mask, [batchsize, station_number+PGA_target (40)]
        # value: True, False (True: should mask)
        pad_mask = torch.cat((station_pad_mask, target_pad_mask), dim=1).to(device)

        add_pe_cnn_output = torch.add(cnn_output_reshape, emb_output)
        transformer_input = torch.cat((add_pe_cnn_output, pga_pos_emb_output), dim=1)
        transformer_output = self.model_Transformer(transformer_input, pad_mask)

        mlp_input = transformer_output[:, -self.pga_targets :, :].to(device)
        mlp_output = self.model_mlp(mlp_input)
        weight, sigma, mu = self.model_MDN(mlp_output)

        return weight, sigma, mu


def gaussian_distribution(y, mu, sigma):
    """
    # make |mu|=K copies of y, subtract mu, divide by sigma
    """
    one_div_sqrt_two_pi = 1.0 / np.sqrt(
        2.0 * np.pi
    )  # normalization factor for Gaussians
    result = (y.expand_as(mu) - mu) * torch.reciprocal(sigma)
    result = -0.5 * (result * result)
    return (torch.exp(result) * torch.reciprocal(sigma)) * one_div_sqrt_two_pi


def mdn_loss_fn(pi, sigma, mu, y):
    result = gaussian_distribution(y, mu, sigma) * pi
    result = torch.sum(result, dim=1)
    result = -torch.log(result)
    return torch.mean(result)


def get_full_model(model_path):
    emb_dim = 150
    mlp_dims = (150, 100, 50, 30, 10)
    cnn_model = CNN(mlp_input=5665).to(device)
    pos_emb_model = PositionEmbeddingVs30(emb_dim=emb_dim).to(device)
    transformer_model = TransformerEncoder()
    mlp_model = MLP(input_shape=(emb_dim,), dims=mlp_dims).to(device)
    mdn_model = MDN(input_shape=(mlp_dims[-1],)).to(device)
    full_model = FullModel(
        cnn_model,
        pos_emb_model,
        transformer_model,
        mlp_model,
        mdn_model,
        pga_targets=25,
        data_length=3000,
    ).to(device)
    full_model.load_state_dict(
        torch.load(model_path, weights_only=True, map_location=device)
    )

    return full_model


app = Flask(__name__)
socketio = SocketIO(app)

# 共享物件
manager = multiprocessing.Manager()

wave_buffer = manager.dict()
wave_queue = manager.Queue()

time_buffer = manager.dict()
pick_buffer = manager.dict()

event_queue = manager.Queue()
dataset_queue = manager.Queue()

report_queue = manager.Queue()

"""
Web Server
"""


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/trace")
def trace_page():
    return render_template("trace.html")


@app.route("/event")
def event_page():
    return render_template("event.html")


@app.route("/dataset")
def dataset_page():
    return render_template("dataset.html")


@app.route("/intensityMap")
def map_page():
    return render_template("intensityMap.html")


@socketio.on("connect")
def connect_earthworm():
    socketio.emit("connect_init")


def wave_emitter():
    while True:
        wave = wave_queue.get()
        wave_id = join_id_from_dict(wave, order="NSLC")

        if "Z" not in wave_id:
            continue

        wave["waveid"] = wave_id

        wave_packet = {
            "waveid": wave_id,
            "data": wave["data"].tolist(),
        }

        socketio.emit("wave_packet", wave_packet)


def event_emitter():
    while True:
        event_data = event_queue.get()
        if not event_data:
            continue

        socketio.emit("event_data", event_data)


def dataset_emitter():
    while True:
        dataset_data = dataset_queue.get()
        if not dataset_data:
            continue

        socketio.emit("dataset_data", dataset_data)


def web_server():
    threading.Thread(target=wave_emitter).start()
    threading.Thread(target=event_emitter).start()
    threading.Thread(target=dataset_emitter).start()

    if args.web or args.host or args.port:
        # 開啟 web server
        app.run(host=args.host, port=args.port, use_reloader=False)
        socketio.run(app, debug=True)


"""
Earthworm Wave Listener
"""

try:
    site_info = pd.read_csv("data/site_info.txt", sep="\s+")
except FileNotFoundError:
    print("site_info.txt not found")


def join_id_from_dict(data, order="NSLC"):
    code = {"N": "network", "S": "station", "L": "location", "C": "channel"}
    data_id = ".".join(data[code[letter]] for letter in order)
    return data_id


def convert_to_tsmip_legacy_naming(wave):
    if wave["network"] == "TW":
        wave["network"] = "SM"
        wave["location"] = "01"
    return wave


def get_wave_constant(wave):
    # count to cm/s^2
    wave_constant = site_info.loc[
        (site_info["Station"] == wave["station"])
        & (site_info["Channel"] == wave["channel"]),
        "Constant",
    ].values[0]

    if not wave_constant:
        wave_constant = 3.2e-6

    return wave_constant


def get_station_position(station):
    latitude, longitude, elevation = site_info.loc[
        (site_info["Station"] == station), ["Latitude", "Longitude", "Elevation"]
    ].values[0]
    return latitude, longitude, elevation


def wave_array_init(sample_rate, buffer_time, fill_value):
    return np.full(sample_rate * buffer_time, fill_value=fill_value)


def time_array_init(sample_rate, buffer_time, start_time, end_time, data_length):
    """
    生成一個時間序列，包含前後兩段
    後段從 start_time 內插至 end_time (確定的時間序列)
    前段從 start_time 外插至 buffer 開始點 (往前預估的時間序列)
    """
    return np.append(
        np.linspace(
            start_time - (buffer_time - 1),
            start_time,
            sample_rate * (buffer_time - 1),
        ),
        np.linspace(start_time, end_time, data_length),
    )


def slide_array(array, data):
    array = np.append(array, data)
    return array[data.size :]


def earthworm_wave_listener():
    buffer_time = 30  # 設定緩衝區保留時間
    sample_rate = 100  # 設定取樣率
    latest_time = 0
    while True:
        if earthworm.mod_sta() is False:
            continue

        wave = earthworm.get_wave(0)
        if not wave:
            continue

        # 如果時間重置(tankplayer 重播)，清空 buffer
        if latest_time > wave["startt"] + 60:
            wave_buffer.clear()
            time_buffer.clear()
            print("time reversed over 60 secs, flush wave and time buffer")
        latest_time = wave["endt"]

        try:
            wave = convert_to_tsmip_legacy_naming(wave)
            wave_id = join_id_from_dict(wave, order="NSLC")
            wave["data"] = wave["data"] * get_wave_constant(wave)

            # 將 wave_id 加入 wave_queue 給 wave_emitter 發送至前端
            if "Z" in wave_id:
                wave_queue.put(wave)

            # add new trace to buffer
            if wave_id not in wave_buffer.keys():
                # wave_buffer 初始化時全部填入 wave 的平均值，確保 demean 時不會被斷點影響
                wave_buffer[wave_id] = wave_array_init(
                    sample_rate, buffer_time, fill_value=np.array(wave["data"]).mean()
                )
                time_buffer[wave_id] = time_array_init(
                    sample_rate,
                    buffer_time,
                    wave["startt"],
                    wave["endt"],
                    wave["data"].size,
                )

            wave_buffer[wave_id] = slide_array(wave_buffer[wave_id], wave["data"])

            new_time_array = np.linspace(
                wave["startt"], wave["endt"], wave["data"].size
            )
            time_buffer[wave_id] = slide_array(time_buffer[wave_id], new_time_array)

        except Exception as e:
            print("earthworm_wave_listener error", e)

        time.sleep(0.000001)


"""
Earthworm Pick Listener
"""


def parse_pick_msg(pick_msg):
    pick_msg_column = pick_msg.split()
    try:
        pick = {
            "station": pick_msg_column[0],
            "channel": pick_msg_column[1],
            "network": pick_msg_column[2],
            "location": pick_msg_column[3],
            "lon": pick_msg_column[4],
            "lat": pick_msg_column[5],
            "pga": pick_msg_column[6],
            "pgv": pick_msg_column[7],
            "pd": pick_msg_column[8],
            "tc": pick_msg_column[9],  # Average period
            "pick_time": pick_msg_column[10],
            "weight": pick_msg_column[11],  # 0:best 5:worst
            "instrument": pick_msg_column[12],  # 1:Acc 2:Vel
            "update_sec": pick_msg_column[13],  # sec after pick
        }

        pick["pickid"] = join_id_from_dict(pick, order="NSLC")

        return pick

    except IndexError:
        print("pick_msg parsing error:", pick_msg)


def earthworm_pick_listener():
    """
    監看 pick ring 的訊息，並保存活著的 pick msg
    pick msg 的生命週期為 p 波後 2-9 秒
    ref: pick_ew_new/pick_ra_0709.c line 283
    """
    while True:
        pick_msg = earthworm.get_msg(buf_ring=2, msg_type=0)
        if not pick_msg:
            continue

        try:
            pick_data = parse_pick_msg(pick_msg)
            pick_id = join_id_from_dict(pick_data, order="NSLC")

            # 2 秒時加入 pick
            if pick_data["update_sec"] == "2":
                pick_buffer[pick_id] = pick_data

            # 9 秒時移除 pick
            elif pick_data["update_sec"] == "9":
                pick_buffer.__delitem__(pick_id)

        except Exception as e:
            print("earthworm_pick_listener error:", e)
            continue

        time.sleep(0.001)


"""
Model Inference
"""
try:
    vs30_table = pd.read_csv(f"data/Vs30ofTaiwan.csv")
    tree = cKDTree(vs30_table[["lat", "lon"]])
except FileNotFoundError:
    print("Vs30ofTaiwan.csv not found")


def event_cutter(pick_buffer):
    event_data = {}
    # pick 只有 Z 軸
    for pick_id, pick in pick_buffer.items():
        network = pick["network"]
        station = pick["station"]
        location = pick["location"]
        channel = pick["channel"]

        data = {}
        # 找到 wave_buffer 內的三軸資料
        for i, component in enumerate(["Z", "N", "E"]):
            try:
                wave_id = f"{network}.{station}.{location}.{channel[0:2]}{component}"
                data[component.lower()] = wave_buffer[wave_id].tolist()

            except KeyError:
                print(f"{wave_id} {component} not found, add zero array")
                wave_id = f"{network}.{station}.{location}.{channel[0:2]}Z"
                data[component.lower()] = np.zeros(3000).tolist()
                continue

        trace_dict = {
            "traceid": pick_id,
            "time": time_buffer[pick_id].tolist(),
            "data": data,
        }

        event_data[pick_id] = {"pick": pick, "trace": trace_dict}

    event_queue.put(event_data)

    return event_data


def signal_processing(waveform):
    try:
        # demean and lowpass filter
        data = detrend(waveform, type="constant")
        data = lowpass(data, freq=10)

        return data

    except Exception as e:
        print("signal_processing error:", e)


def lowpass(data, freq=10, df=100, corners=4):
    """
    Modified form ObsPy Signal Processing
    https://docs.obspy.org/_modules/obspy/signal/filter.html#lowpass
    """
    fe = 0.5 * df
    f = freq / fe

    if f > 1:
        f = 1.0
    z, p, k = iirfilter(corners, f, btype="lowpass", ftype="butter", output="zpk")
    sos = zpk2sos(z, p, k)

    return sosfilt(sos, data)


def get_vs30(lat, lon):
    try:
        distance, i = tree.query([float(lat), float(lon)])
        vs30 = vs30_table.iloc[i]["Vs30"]
        return float(vs30)

    except Exception as e:
        print("get_vs30 error", e)


def get_site_info(pick):
    try:
        latitude, longitude, elevation = get_station_position(pick["station"])
        vs30 = get_vs30(latitude, longitude)
        return [latitude, longitude, elevation, vs30]

    except Exception as e:
        print("get_site_info error:", e)


def get_target(dataset, target_file="data/eew_target.txt"):
    try:
        target_df = pd.read_csv(target_file, sep=",")

        target_list = []
        target_name_list = []
        target_dict = target_df.to_dict(orient="records")
        for i, target in enumerate(target_dict):
            latitude = target["latitude"]
            longitude = target["longitude"]
            elevation = target["elevation"]
            target_list.append(
                [latitude, longitude, elevation, get_vs30(latitude, longitude)]
            )
            target_name_list.append(target["station"])

        dataset["target"] = target_list
        dataset["target_name"] = target_name_list

        return dataset

    except FileNotFoundError:
        print("eew_target.txt not found")

    except Exception as e:
        print("get_target error:", e)


def convert_dataset(event_msg):
    try:
        waveform_list = []
        station_list = []
        station_name_list = []

        for i, (pick_id, data) in enumerate(event_msg.items()):
            trace = []
            for j, component in enumerate(["Z", "N", "E"]):
                waveform = data["trace"]["data"][component.lower()]
                waveform = signal_processing(waveform)
                trace.append(waveform.tolist())

            waveform_list.append(trace)
            station_list.append(get_site_info(data["pick"]))
            station_name_list.append(data["pick"]["station"])

        dataset = {
            "waveform": waveform_list,
            "station": station_list,
            "station_name": station_name_list,
        }

        return dataset

    except Exception as e:
        print("converter error:", e)


def convert_torch_tensor(dataset):
    try:
        station_limit = min(len(dataset["waveform"]), 25)
        target_limit = min(len(dataset["target"]), 25)

        wave = np.array(dataset["waveform"])
        wave_transposed = wave.transpose(0, 2, 1)

        waveform = np.zeros((25, 3000, 3))
        station = np.zeros((25, 4))
        target = np.zeros((25, 4))

        # 取前 25 筆資料，不足的話補 0
        waveform[:station_limit] = wave_transposed[:station_limit]
        station[:station_limit] = dataset["station"][:station_limit]
        target[:target_limit] = dataset["target"][:target_limit]

        input_waveform = torch.tensor(waveform).to(torch.double).unsqueeze(0)
        input_station = torch.tensor(station).to(torch.double).unsqueeze(0)
        target_station = torch.tensor(target).to(torch.double).unsqueeze(0)
        tensor = {
            "waveform": input_waveform,
            "station": input_station,
            "station_name": dataset["station_name"][:station_limit],
            "target": target_station,
            "target_name": dataset["target_name"][:target_limit],
        }

        return tensor

    except Exception as e:
        print("reorder_array error:", e)


def ttsam_model_predict(dataset):
    try:
        model_path = f"model/ttsam_trained_model_11.pt"
        full_model = get_full_model(model_path)
        tensor = convert_torch_tensor(dataset)
        weight, sigma, mu = full_model(tensor)

        pga_list = torch.sum(weight * mu, dim=2).cpu().detach().numpy().flatten()
        pga_list = pga_list[: len(tensor["target_name"])]

        dataset["pga"] = pga_list.tolist()

        return dataset

    except Exception as e:
        print("ttsam_model_predict error:", e)


def calculate_intensity(pga, pgv=None, label=False):
    try:
        intensity_label = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"]
        pga_level = np.log10(
            [1e-5, 0.008, 0.025, 0.080, 0.250, 0.80, 1.4, 2.5, 4.4, 8.0]
        )  # log10(m/s^2)

        pgv_level = np.log10(
            [1e-5, 0.002, 0.007, 0.019, 0.057, 0.15, 0.3, 0.5, 0.8, 1.4]
        )  # log10(m/s)

        pga_intensity = bisect.bisect(pga_level, pga) - 1
        intensity = pga_intensity

        if pga > pga_level[5] and pgv is not None:
            pgv_intensity = bisect.bisect(pgv_level, pgv) - 1
            if pgv_intensity > pga_intensity:
                intensity = pgv_intensity

        if label:
            return intensity_label[intensity]

        else:
            return intensity

    except Exception as e:
        print("calculate_intensity error:", e)


def model_inference():
    """
    進行模型預測
    """
    while True:
        # 小於 3 個測站不觸發模型預測
        if len(pick_buffer) < 3:
            time.sleep(0.5)
            continue

        try:
            start_time = time.time()

            event_data = event_cutter(pick_buffer)
            dataset = convert_dataset(event_data)
            dataset = get_target(dataset)
            dataset = ttsam_model_predict(dataset)

            dataset["intensity"] = [
                calculate_intensity(pga, label=True) for pga in dataset["pga"]
            ]
            report = {"over_threshold": []}

            for i, intensity in enumerate(dataset["intensity"]):
                report[f"{dataset['target_name'][i]}"] = intensity

                if intensity in ["4", "5-", "5+", "6-", "6+", "7"]:
                    report["over_threshold"].append(dataset["target_name"][i])

            # 資料傳至 MQTT
            mqtt_client.publish(topic, json.dumps(report))
            print(report)

            # 資料傳至前端
            dataset_queue.put(dataset)
            end_time = time.time()
            print("model_inference time:", end_time - start_time)

        except Exception as e:
            print("model_inference error:", e)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--web", action="store_true", help="run web server")
    parser.add_argument("--host", type=str, help="web server ip")
    parser.add_argument("--port", type=int, help="web server port")
    args = parser.parse_args()

    # 初始化 Earthworm
    earthworm = PyEW.EWModule(
        def_ring=1000, mod_id=2, inst_id=255, hb_time=30, db=False
    )
    earthworm.add_ring(1000)  # buf_ring 0: Wave ring(tank player)
    earthworm.add_ring(1002)  # buf_ring 1: Wave ring 2
    earthworm.add_ring(1005)  # buf_ring 2: Pick ring

    # 初始化 MQTT
    mqtt_client = mqtt.Client()
    mqtt_client.username_pw_set("ttsam", "ttsam")
    mqtt_client.connect("0.0.0.0", 1883)
    topic = "ttsam"

    processes = []
    functions = [
        earthworm_wave_listener,
        earthworm_pick_listener,
        model_inference,
        web_server,
    ]

    # 為每個函數創建一個持續運行的 process
    for func in functions:
        p = multiprocessing.Process(target=func)
        processes.append(p)
        p.start()
