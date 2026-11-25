ARG WINDLASS_IMAGE
FROM ${WINDLASS_IMAGE}
USER root
COPY --chmod=0444 process.py /usr/local/lib/wlp-daytona-process.py
# The toolbox can launch the fixed bridge as either guest identity. Neither can invoke sudo.
RUN apt-get update && apt-get install -y --no-install-recommends sudo && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home-dir /var/lib/wlp-launcher --shell /bin/sh wlp-launcher \
 && install -d -m 0755 /var/lib/wlp-launcher \
 && printf '%s\n' 'Defaults:wlp-launcher !use_pty' \
    'wlp-launcher ALL=(agent,nobody) NOPASSWD: /usr/bin/setpriv --no-new-privs /usr/bin/python3 -I /usr/local/lib/wlp-daytona-process.py' \
    > /etc/sudoers.d/wlp-launcher \
 && chmod 0440 /etc/sudoers.d/wlp-launcher && visudo -cf /etc/sudoers
USER wlp-launcher
ENV HOME=/var/lib/wlp-launcher
