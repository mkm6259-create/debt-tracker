# DebtTracker Cloud Deployment

This folder contains everything needed to deploy DebtTracker to the cloud for 24/7 availability.

## Files Included

- `server.js` - Node.js/Express backend API
- `package.json` - Dependencies
- `debt_tracker.db` - SQLite database with your debtors
- `Dockerfile` - Docker configuration for cloud deployment
- `docker-compose.yml` - Local testing configuration
- `backups/` - Automatic backup directory

## Quick Deploy (Render)

### 1. Prepare Your Repository

```bash
cd /home/ubuntu/debt-tracker-backend
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/debt-tracker.git
git push -u origin main
```

### 2. Deploy to Render

1. Go to https://render.com
2. Click "New +" → "Web Service"
3. Select "Public Git repository"
4. Paste your GitHub URL
5. Configure:
   - **Name:** debttracker
   - **Runtime:** Docker
   - **Plan:** Free (or $7/month)
6. Add Environment Variable:
   - `JWT_SECRET=your-secret-key-12345`
7. Click "Deploy"

### 3. Get Your URL

After 5-10 minutes, you'll get a URL like:
```
https://debttracker-xyz.onrender.com
```

### 4. Update Web App

In `debt-tracker-final.html`, change:
```javascript
const API_URL = 'https://debttracker-xyz.onrender.com/api';
```

## Local Testing

To test before deploying:

```bash
# Install Docker if needed
# Then run:
docker-compose up
```

Visit: http://localhost:3001/api/health

## Environment Variables

Required:
- `JWT_SECRET` - Secret key for JWT tokens (change in production!)
- `NODE_ENV` - Set to `production`

Optional:
- `PORT` - Server port (default: 3001)

## Database

Your SQLite database (`debt_tracker.db`) contains:
- All your debtors (Calili, Moo)
- All debts and payments
- User accounts (admin)

The database is automatically included in the Docker image.

## Backups

Automatic backups are created:
- Every 6 hours
- On every transaction
- Stored in `backups/` directory

## Security

⚠️ Important for production:
1. Change `JWT_SECRET` to a strong random string
2. Enable HTTPS (automatic on Render/Railway)
3. Set up regular backups
4. Monitor database size

## Troubleshooting

### App won't start
- Check `JWT_SECRET` is set
- Verify database file exists
- Check logs in cloud provider dashboard

### Database errors
- Ensure `debt_tracker.db` is in the Docker image
- Check file permissions
- Verify database isn't corrupted

### API returns 404
- Verify API_URL is correct in web app
- Check cloud provider logs
- Ensure server is running

## Support

For issues:
1. Check cloud provider logs
2. Verify environment variables
3. Test locally with docker-compose
4. Check database integrity

## Cost

- **Render Free:** $0 (limited)
- **Render Paid:** $7/month
- **Railway:** $5/month
- **DigitalOcean:** $6/month

## Next Steps

1. Push code to GitHub
2. Deploy to Render/Railway/DigitalOcean
3. Update web app URL
4. Test login and data sync
5. Share URL with other devices!

---

**Your DebtTracker is ready for the cloud!** 🚀
