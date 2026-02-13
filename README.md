# ISweep Chrome Extension

Safe content filtering for a better browsing experience.

## 🚀 Quick Start

### Installation

1. **Load the Extension in Chrome:**
   ```bash
   # Navigate to chrome://extensions/
   # Enable "Developer mode"
   # Click "Load unpacked"
   # Select the isweep-chrome-extension/ folder
   ```

2. **Start the Demo Web Server:**
   ```bash
   cd /path/to/ISweep_extention
   python3 -m http.server 5500
   ```

3. **Test the Extension:**
   - Click the ISweep icon in Chrome toolbar
   - Follow the testing guide in `TESTING.md`

## 📚 Documentation

- **[Extension README](isweep-chrome-extension/README.md)** - Extension-specific documentation
- **[Testing Guide](TESTING.md)** - Comprehensive manual testing procedures
- **[Implementation Summary](IMPLEMENTATION_SUMMARY.md)** - Detailed implementation overview
- **[UI Preview](UI_PREVIEW.md)** - Visual representation of UI states

## ✨ Features

### Two-State Popup UI
- **Logged Out State:** Clean login interface with email authentication
- **Logged In State:** User dashboard with status indicators and quick actions

### User Authentication
- Local storage-based authentication (`chrome.storage.local`)
- Quick email login for development
- Web app integration for production login

### Status Management
- Visual indicators for active/paused filtering
- Dynamic icon changes based on enabled state
- Persistent state across browser sessions

### Web App Integration
- Direct links to ISweep Settings page
- Account management integration
- Filter reset functionality

## 📁 Project Structure

```
ISweep_extention/
├── isweep-chrome-extension/    # Main extension folder
│   ├── manifest.json           # Chrome Extension v3 manifest
│   ├── popup.html              # Popup UI (logged out/in states)
│   ├── popup.css               # Professional styling
│   ├── popup.js                # State management & logic
│   ├── background.js           # Service worker for icon mgmt
│   ├── plumbing.js             # Content script for filtering
│   ├── options.html/js         # Options page (placeholder)
│   ├── icons/                  # Extension icons
│   └── README.md               # Extension documentation
├── docs/                       # Demo web app
│   ├── Settings.html           # Settings page demo
│   └── Account.html            # Login/account page demo
├── TESTING.md                  # Testing guide (15+ test cases)
├── IMPLEMENTATION_SUMMARY.md   # Detailed implementation docs
├── UI_PREVIEW.md               # UI mockups and previews
└── README.md                   # This file
```

## 🎯 Key Requirements Met

✅ Minimal two-state popup (Logged Out / Logged In)  
✅ Styling matches ISweep Settings page aesthetic  
✅ Authentication with chrome.storage.local  
✅ Web Settings integration with direct links  
✅ Enabled/Paused state management  
✅ Icon state switching (ON/OFF)  
✅ Well-commented, production-ready code  
✅ Comprehensive testing documentation  

## 🧪 Testing

The extension includes a comprehensive testing guide with 15+ manual test cases covering:

- Login/logout flows
- State persistence
- Web app integration
- Icon state management
- Content script functionality
- Error handling

See **[TESTING.md](TESTING.md)** for detailed test procedures.

## 🔧 Development

### Prerequisites
- Google Chrome or Chromium browser
- Python 3 (for local web server) or alternative
- Text editor or IDE

### Local Development
```bash
# Clone the repository
git clone https://github.com/kthrnbeh/ISweep_extention.git
cd ISweep_extention

# Start web server
python3 -m http.server 5500

# Load extension in Chrome
# chrome://extensions/ → Enable Developer mode → Load unpacked
```

### Web App URL Configuration
Update `WEB_BASE_URL` in `isweep-chrome-extension/popup.js`:
```javascript
const WEB_BASE_URL = 'http://127.0.0.1:5500/docs';  // Development
// const WEB_BASE_URL = 'https://isweep.com';       // Production
```

## 📊 Statistics

- **Total Files:** 21
- **Lines of Code:** ~1,100+
- **Test Cases:** 15+
- **Documentation Pages:** 5

## 🔮 Future Enhancements

- OAuth/SSO integration for production
- Actual content filtering algorithms
- Statistics dashboard
- Dark mode support
- Cross-device sync
- Custom filter rules

## 📝 License

© 2025 ISweep Inc.

## 🤝 Contributing

This is a private repository. For contributions, please contact the repository owner.

## 📧 Support

For issues or questions, please create an issue in this repository or contact the development team.
