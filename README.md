# TTSAM (Taiwan Transformer Seismic Alert Model)

A real-time seismic intensity prediction system that utilizes deep learning to process seismic waveforms and predict ground motion intensities across Taiwan.

![TTSAM_Realtime_Architecture](TTSAM_Realtime_Architecture.png)

## Features

- Real-time seismic waveform processing
- Deep learning-based ground motion prediction
- Integration with Earthworm seismic processing system
- Web-based visualization interface
- MQTT support for real-time notifications
- Multi-station processing capability

## Requirements

- Earthworm
- MQTT broker
- Docker 

## Installation

1. Clone this repository
```bash
git clone https://github.com/SeisBlue/TTSAM_Realtime.git
```

2. Pull the Docker image:
```bash
docker pull seisblue/ttsam-realtime
```
3. Prepare the required data files in the `data` directory:
    - `site_info.txt`: Station information
    - `Vs30ofTaiwan.csv`: VS30 data for Taiwan
    - `eew_target.txt`: Target stations for prediction

4. Place trained model in the `model` directory:
    - `ttsam_trained_model_11.pt`

## Usage

Run the system with:

```bash
docker run \
-v $(pwd):/workspace \
-v /opt/Earthworm/run/params:/opt/Earthworm/run/params:ro \
--rm \
--ipc host \
--net host \
--name ttsam-cpu \
seisblue/ttsam-realtime \
/opt/conda/bin/python3 /workspace/ttsam_realtime.py [options]
```

Options:
- `--config`: MQTT configuration file, default: `config.json`
- `--web`: Run the web server, default: `False`
- `--host`: Web server IP, default: `0.0.0.0`
- `--port`: Web server port, default: `5000`


## System Components

- Wave Listener: Processes incoming seismic waveforms
- Pick Listener: Handles phase picks and triggering
- Model Inference: Runs deep learning prediction
- Web Server: Provides visualization interface
- MQTT Client: Broadcasts predictions

## Model Architecture

[TT-SAM](https://github.com/JasonChang0320/TT-SAM)

The system uses a deep learning model combining:
- CNN for waveform processing
- Transformer for station data integration
- MDN (Mixture Density Network) for uncertainty estimation

## References
Münchmeyer, J., Bindi, D., Leser, U., & Tilmann, F. (2021). The transformer earthquake
alerting model: A new versatile approach to earthquake early warning. Geophysical Journal
International, 225(1), 646-656.
(https://academic.oup.com/gji/article/225/1/646/6047414)

Liu, Kun-Sung, Tzay-Chyn Shin, and Yi-Ben Tsai. (1999). A free-field strong motion
network in Taiwan: TSMIP. Terrestrial, Atmospheric and Oceanic Sciences, 10(2), 377-396.
(http://tao.cgu.org.tw/index.php/articles/archive/geophysics/item/308)

Akazawa, T. (2004, August). A technique for automatic detection of onset time of P-and Sphases
in strong motion records. In Proc. of the 13th world conf. on earthquake engineering
(Vol. 786, p. 786). Vancouver, Canada.
(https://www.iitk.ac.in/nicee/wcee/article/13_786.pdf)

Kuo, C. H., Wen, K. L., Hsieh, H. H., Lin, C. M., Chang, T. M., & Kuo, K. W. (2012). Site
classification and Vs30 estimation of free-field TSMIP stations using the logging data of
EGDT. Engineering Geology, 129, 68-75.
(https://www.sciencedirect.com/science/article/pii/S0013795212000397)

Lee, C. T., & Tsai, B. R. (2008). Mapping Vs30 in Taiwan. TAO: Terrestrial, Atmospheric
and Oceanic Sciences, 19(6), 6.
(https://www.researchgate.net/profile/Chyi-Tyi-Lee-2/publication/250211755_Mapping_Vs30_in_Taiwan/links/557fa82608aeb61eae262086/Mapping-Vs30-in-Taiwan.pdf)

Huang, H. H., Wu, Y. M., Song, X., Chang, C. H., Lee, S. J., Chang, T. M., & Hsieh, H. H.
(2014). Joint Vp and Vs tomography of Taiwan: Implications for subduction-collision
orogeny. Earth and Planetary Science Letters, 392, 177-191.
(https://www.sciencedirect.com/science/article/pii/S0012821X14000995)