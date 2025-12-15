import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Login from "./Login";
import Register from "./Register";
import ForgotPassword from "./ForgotPassword";
import Dashboard from "./Dashboard";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/" element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  );
}
