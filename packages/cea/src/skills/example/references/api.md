# API Reference

## Overview

This is an example API reference document stored in a v2 skill subdirectory.

## Endpoints

### GET /api/health
Check service health status

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-01-19T00:00:00Z"
}
```

### POST /api/data
Submit data to the service

**Request:**
```json
{
  "key": "value",
  "data": "example"
}
```

**Response:**
```json
{
  "success": true,
  "id": "12345"
}
```
