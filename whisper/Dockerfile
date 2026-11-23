# Keep the existing application and API contract; refresh its Debian Brotli libraries.
FROM onerahmet/openai-whisper-asr-webservice:v1.10.0@sha256:0616c3d5fc6924e9d59aa8a7a3a944fbe8f3a5d701e5fc1fa2ce5b933dfecb73

RUN . /etc/os-release \
    && test "$VERSION_CODENAME" = bookworm \
    && apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade libbrotli1 libbrotli-dev \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge '1.0.9-2+deb12u1' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli-dev)" ge '1.0.9-2+deb12u1' \
    && rm -rf /var/lib/apt/lists/*
