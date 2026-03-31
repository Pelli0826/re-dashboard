FROM node:20-slim

# Install build tools + Ghostscript + ImageMagick for PDF-to-image conversion
RUN apt-get update && apt-get install -y \
  python3 make g++ \
  ghostscript imagemagick \
  && rm -rf /var/lib/apt/lists/*

# Allow ImageMagick to read PDFs (disabled by default for security)
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml || true

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Expose port
EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

CMD ["npm", "run", "start"]
