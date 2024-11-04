FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

# Ignore all interactive dialog during apt-get update
ENV DEBIAN_FRONTEND=noninteractive

# Install linux package
RUN apt-get update && apt-get upgrade -y; \
    apt-get install -y \
    curl git htop sudo vim wget\
    python3-dev python3-pip libgeos-dev pkg-config libhdf5-dev\
    ghostscript gdal-bin graphicsmagick ffmpeg

# Install conda package
COPY docker/conda_requirements.txt /tmp/
RUN conda update -y conda; \
    conda install --yes --channel conda-forge --file /tmp/conda_requirements.txt;

# Install python package
COPY docker/requirements.txt /tmp/
RUN /opt/conda/bin/python3 -m pip install --upgrade pip; \
    /opt/conda/bin/python3 -m pip --no-cache-dir install -r /tmp/requirements.txt;

# Get Earthworm
RUN wget http://folkworm.ceri.memphis.edu/ew-dist/v7.10.1/earthworm_7.10.1-ubuntu18.04-64bit-bin.tar.gz; \
    mkdir /opt/Earthworm; \
    tar -xvf earthworm_7.10.1-ubuntu18.04-64bit-bin.tar.gz -C /opt/Earthworm;

# Install PyEarthworm
ENV EW_HOME=/opt/Earthworm/earthworm_7.10
ENV EW_PARAMS=/opt/Earthworm/run/params
ENV CFLAGS="-fno-stack-protector -fPIC -Dlinux -D_LINUX -D_USE_SCHED -D_USE_PTHREADS -D_USE_TERMIOS -I${EW_HOME}/include"
RUN /opt/conda/bin/python3 -m pip install git+https://github.com/Boritech-Solutions/PyEarthworm