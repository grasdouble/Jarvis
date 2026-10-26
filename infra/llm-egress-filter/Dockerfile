ARG PYTHON_BASE_IMAGE
FROM ${PYTHON_BASE_IMAGE}
WORKDIR /opt/jarvis
COPY filter.py /opt/jarvis/filter.py
COPY egress.example.json /etc/jarvis/egress.json
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["python3", "/opt/jarvis/filter.py"]
