FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

<<<<<<< HEAD
CMD ["npm", "start"]
=======
CMD ["npm", "start"]
>>>>>>> 78894e79b8903968077ba7c6e82787e8ef194445
