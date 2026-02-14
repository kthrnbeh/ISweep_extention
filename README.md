# ISweep Chrome Extension

Safe content filtering for a better browsing experience.

## Features

### Secure Authentication
Users log in through the ISweep web platform. Authentication state is securely stored using `chrome.storage.local` and persists across sessions.

### Active / Paused Control
Users can enable or pause filtering directly from the popup. The extension icon updates automatically to reflect the current state.

### Web App Integration
Quick access links inside the popup:
• Open Settings  
• Manage Account  
• Reset Filters  
• Log Out  

---

## How It Works

1. Install the extension from the Chrome Web Store.
2. Click the ISweep icon in the Chrome toolbar.
3. Sign in to your ISweep account.
4. Manage filtering status or open your dashboard.

The extension communicates with the ISweep web application for account and settings management.

---

## Permissions Used

This extension uses the following permissions:

• `storage` — to securely store login and filtering state  
• `activeTab` — to interact with the currently active tab  
• `scripting` — to inject content scripts for filtering behavior  
• `host_permissions` — required to apply filtering functionality on supported pages  

No personal data is sold or shared.

---

## Privacy

ISweep does not collect or transmit personal browsing data.

Authentication state and filtering preferences are stored locally using Chrome’s storage API.

For full details, please see our Privacy Policy:
[Insert Privacy Policy URL Here]

---

## Support

For help, questions, or bug reports:

• Visit: [Insert Website URL]  
• Contact: [Insert Support Email]

---

## Version

Current Version: 1.0.0  
Built with Chrome Extension Manifest v3

© 2026 ISweep
