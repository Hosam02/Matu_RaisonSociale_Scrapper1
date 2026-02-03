# -----------------------------
# Base image with Node 20
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
# Install Playwright browsers
# -----------------------------
RUN npx playwright install --with-deps

# -----------------------------
# Set environment variables
# -----------------------------
ENV PORT=3005
ENV CHARIKA_USERNAME=H.QOTBI@matu.ma
ENV CHARIKA_PASSWORD=Houssam@2002

# -----------------------------
# Expose the API port
# -----------------------------
EXPOSE 3005

# -----------------------------
# Default command to run the API
# -----------------------------
CMD ["node", "index.js"]
