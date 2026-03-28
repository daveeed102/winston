FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc libffi-dev && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py .
COPY test_sell.py .
# Switch CMD to test_sell.py to diagnose sell failures.
# Change back to bot.py after the test.
CMD ["python", "-u", "test_sell.py"]
