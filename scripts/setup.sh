#!/bin/bash
# ============================================
# TD Automation - Initial Setup Script
# ============================================

set -e

echo "🚀 Setting up TD Automation..."

# Check prerequisites
echo "📋 Checking prerequisites..."

command -v node >/dev/null 2>&1 || { echo "❌ Node.js is required. Install from https://nodejs.org"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required. Install from https://docker.com"; exit 1; }
command -v python >/dev/null 2>&1 || { echo "❌ Python is required. Install from https://python.org"; exit 1; }

echo "✅ Node.js $(node --version)"
echo "✅ Docker $(docker --version | cut -d' ' -f3)"
echo "✅ Python $(python --version | cut -d' ' -f2)"

# Copy environment file
if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 Created .env from .env.example — update with your credentials"
else
  echo "📝 .env already exists, skipping..."
fi

# Start infrastructure
echo "🐳 Starting PostgreSQL and Redis..."
docker-compose up -d

# Wait for services
echo "⏳ Waiting for services to be ready..."
sleep 5

# Install dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# Generate Prisma client
echo "🔧 Generating Prisma client..."
cd apps/api && npx prisma generate && cd ../..

# Run database migrations
echo "🗃️ Running database migrations..."
cd apps/api && npx prisma migrate dev --name init && cd ../..

# Setup Python AI engine
echo "🐍 Setting up AI engine..."
cd ai-engine
python -m venv venv
source venv/bin/activate 2>/dev/null || venv/Scripts/activate 2>/dev/null
pip install -r requirements.txt
deactivate
cd ..

echo ""
echo "✅ Setup complete! To start development:"
echo ""
echo "  1. Update .env with your Angel One API credentials"
echo "  2. npm run dev:web    → Frontend on http://localhost:3000"
echo "  3. npm run dev:api    → Backend on http://localhost:3001"
echo "  4. npm run dev:ai     → AI Engine on http://localhost:5000"
echo ""
echo "🎯 Happy trading!"
