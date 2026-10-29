<script type="module">
  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
  import { getAnalytics } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-analytics.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyBWjd_9WhqO6IaAgT_EBxIPDj54-zBRmEs",
    authDomain: "echoreply-87d81.firebaseapp.com",
    projectId: "echoreply-87d81",
    storageBucket: "echoreply-87d81.firebasestorage.app",
    messagingSenderId: "423050648217",
    appId: "1:423050648217:web:853e4137488e4c86217608",
    measurementId: "G-WE9NV26DHS"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const analytics = getAnalytics(app);
</script>
