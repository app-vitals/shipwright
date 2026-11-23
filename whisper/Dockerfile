# Keep the existing application and API contract; refresh its Debian Brotli libraries.
FROM onerahmet/openai-whisper-asr-webservice:v1.11.0@sha256:ee1be3f75828d009517d1f27be2a6a52d0ca5e8e9f6a0d75ed65fd492fa25810

RUN . /etc/os-release \
    && test "$VERSION_CODENAME" = bookworm \
    && apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade libbrotli1 libbrotli-dev \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge '1.0.9-2+deb12u1' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli-dev)" ge '1.0.9-2+deb12u1' \
    && rm -rf /var/lib/apt/lists/*
