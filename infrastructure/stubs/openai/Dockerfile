FROM python:3.11-slim-bookworm
WORKDIR /app
COPY server.py ./
USER nobody:nogroup
EXPOSE 8002
CMD ["python", "-u", "server.py"]
