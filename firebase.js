import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyBWjd_9WhqO6IaAgT_EBxIPDj54-zBRmEs",
  authDomain: "echoreply-87d81.firebaseapp.com",
  projectId: "echoreply-87d81",
  storageBucket: "echoreply-87d81.firebasestorage.app",
  messagingSenderId: "423050648217",
  appId: "1:423050648217:web:853e4137488e4c86217608",
  measurementId: "G-WE9NV26DHS"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const analytics = getAnalytics(app);
export default app;
