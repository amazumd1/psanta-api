FROM node:18-alpine
WORKDIR /app

# lockfile ho to fast, repeatable builds
COPY package*.json ./
RUN npm install --omit=dev

# app code
COPY . .

# prod env + correct network binding
ENV NODE_ENV=production HOST=0.0.0.0
EXPOSE 5000

# start express
CMD ["node","server.js"]
