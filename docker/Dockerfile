FROM pytorch/pytorch:2.9.0-cuda13.0-cudnn9-runtime

# Ignore all interactive dialog during apt-get update
ENV DEBIAN_FRONTEND=noninteractive

# Install linux package
RUN apt-get update && apt-get upgrade -y; \
    apt-get install -y \
    curl git htop sudo vim wget build-essential nodejs npm; \
    npm install -g pnpm

# Install python package
COPY docker/requirements.txt /tmp/
RUN /opt/conda/bin/python3 -m pip install --upgrade pip; \
    /opt/conda/bin/python3 -m pip --no-cache-dir install -r /tmp/requirements.txt;

# Get Earthworm
RUN mkdir -p /opt/earthworm /opt/Earthworm/run/params /opt/Earthworm/run/logs &&  \
    wget http://www.earthwormcentral.org/distribution/earthworm_8.0b1-ubuntu24.04-bin.tar.gz && \
    tar -xzf earthworm_8.0b1-ubuntu24.04-bin.tar.gz -C /opt/earthworm && \
    rm earthworm_8.0b1-ubuntu24.04-bin.tar.gz \

COPY pick_eew /opt/Earthworm/earthworm_8.0/bin/

# Install PyEarthworm
ENV EW_VERSION="8.0"
ENV EW_HOME=/opt/earthworm/earthworm_8.0
ENV EW_PARAMS=/opt/earthworm/run/params
ENV CFLAGS="-fno-stack-protector -fPIC -Dlinux -D_LINUX -D_USE_SCHED -D_USE_PTHREADS -D_USE_TERMIOS -I${EW_HOME}/include"
RUN /opt/conda/bin/python3 -m pip install git+https://github.com/Boritech-Solutions/PyEarthworm
