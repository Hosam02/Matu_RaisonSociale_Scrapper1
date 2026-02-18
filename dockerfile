# -----------------------------
# Base image with Node 24
# -----------------------------
FROM node:24-bullseye

# -----------------------------
# Install dependencies required by Playwright / Chromium
# -----------------------------
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libasound2 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# -----------------------------
# Set working directory
# -----------------------------
WORKDIR /app

# -----------------------------
# Copy package files & install dependencies
# -----------------------------
COPY package*.json ./
RUN npm install

# -----------------------------
# Copy project files
# -----------------------------
COPY . .

# -----------------------------
# Install Playwright browsers (Chromium only to save time/space)
# -----------------------------
RUN npx playwright install chromium

# -----------------------------
# Set environment variables
# -----------------------------
ENV PORT=3005
ENV CHARIKA_USERNAME=H.QOTBI@matu.ma
ENV CHARIKA_PASSWORD=Houssam@2002
ENV DB_HOST=192.168.80.61
ENV DB_PORT=1433
ENV DB_USER=ss_appsmatu
ENV DB_PASSWORD=@pmatu$ql84
ENV DB_NAME=Corps25
ENV DB_ENCRYPT=false
ENV DB_TRUST_CERT=true

# -----------------------------
# Expose the API port
# -----------------------------
EXPOSE 3005

# -----------------------------
# Default command to run the API
# -----------------------------
CMD ["node", "index.js"]
