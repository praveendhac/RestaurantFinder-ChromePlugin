# 🍴 Best Restaurant Finder – Chrome Extension

This Chrome extension helps you find the **top 2 restaurants** in a given city for any food item using **Google Gemini Flash 2.0 API**.

## 📦 Features
- Short description of the food item.
- Best **two restaurants** with name, address, Google Maps link, and 4 reasons.
- Indigo, Saffron, and Light Green UI.
- Encrypted storage of Gemini API Key.
- Fallback in case Gemini returns invalid JSON.

## 🛠️ Installation
1. Clone or download this repository.
2. Open **Chrome** → `chrome://extensions/`
3. Enable **Developer mode** → **Load unpacked** → Select project folder.

## 🔑 Configure API Key
1. Get your API Key from [Google AI Studio](https://ai.google.dev/).
2. Open popup → Enter API key → Save.

## 🚀 Usage
1. Enter city (`Hyderabad, Telangana, India`).
2. Enter food item (`Qubani ka Meetha`).
3. Click **Find Restaurants** → View results.

## 📂 Project Structure
```
best-restaurant-finder/
│── manifest.json
│── popup.html
│── popup.js
│── styles.css
│── crypto-js/
│── icons/
│── README.md
```

## 📜 License
MIT License
