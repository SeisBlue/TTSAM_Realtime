FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime

# Ignore all interactive dialog during apt-get update
ENV DEBIAN_FRONTEND=noninteractive

# Install linux package
RUN apt-get update && apt-get upgrade -y; \
    apt-get install -y \
    curl git htop sudo vim wget build-essential

# Install python package
COPY docker/requirements.txt /tmp/
RUN /opt/conda/bin/python3 -m pip install --upgrade pip; \
    /opt/conda/bin/python3 -m pip --no-cache-dir install -r /tmp/requirements.txt;

# Get Earthworm
RUN wget http://www.earthwormcentral.org/distribution/earthworm_8.0b1-ubuntu24.04-bin.tar.gz; \
    mkdir /opt/Earthworm; \
    tar -xvf earthworm_8.0b1-ubuntu24.04-bin.tar.gz -C /opt/Earthworm;

# Install PyEarthworm
ENV EW_HOME=/opt/Earthworm/earthworm_8.0
ENV EW_PARAMS=/opt/Earthworm/run/params
ENV CFLAGS="-fno-stack-protector -fPIC -Dlinux -D_LINUX -D_USE_SCHED -D_USE_PTHREADS -D_USE_TERMIOS -I${EW_HOME}/include"
RUN /opt/conda/bin/python3 -m pip install git+https://github.com/Boritech-Solutions/PyEarthworm
