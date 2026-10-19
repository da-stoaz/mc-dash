cd /home/stoaz/mc-dash
export PATH="/home/stoaz/.nvm/versions/node/v24.22.0/bin:$PATH"

git fetch origin &&
git merge --no-edit origin/main &&
(cd backend && npm ci && npm run build) &&
sudo systemctl restart mc-dash-backend