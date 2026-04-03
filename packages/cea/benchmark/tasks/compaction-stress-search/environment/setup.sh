#!/bin/bash
# Setup script: seeds the /work directory with a fake microservice codebase
# Each file is ~300-600 tokens to force heavy context usage when read
set -e

mkdir -p /work/src/config /work/src/services /work/src/middleware /work/src/utils

# ── CONFIG FILES ──────────────────────────────────────────

cat > /work/src/config/database.json << 'SEED'
{
  "database": {
    "host": "db.internal.prod.example.com",
    "port": 5432,
    "name": "appdb_production",
    "username": "app_service",
    "password_env": "DB_PASSWORD",
    "pool": {
      "min": 5,
      "max": 20,
      "idle_timeout_ms": 30000,
      "acquire_timeout_ms": 10000
    },
    "ssl": {
      "enabled": true,
      "ca_path": "/etc/ssl/certs/rds-ca-2019-root.pem",
      "reject_unauthorized": true
    },
    "replication": {
      "read_replicas": [
        "db-read-1.internal.prod.example.com",
        "db-read-2.internal.prod.example.com"
      ],
      "strategy": "round_robin"
    },
    "migrations": {
      "auto_run": false,
      "directory": "/app/migrations"
    }
  }
}
SEED

cat > /work/src/config/redis.json << 'SEED'
{
  "redis": {
    "host": "redis.internal.prod.example.com",
    "port": 6380,
    "password_env": "REDIS_PASSWORD",
    "db": 0,
    "key_prefix": "myapp:",
    "cluster": {
      "enabled": false,
      "nodes": []
    },
    "timeouts": {
      "connect_ms": 5000,
      "command_ms": 3000,
      "reconnect_delay_ms": 1000
    },
    "pools": {
      "cache": { "db": 0, "max_connections": 50 },
      "session": { "db": 1, "max_connections": 30 },
      "queue": { "db": 2, "max_connections": 20 }
    },
    "sentinel": {
      "enabled": false,
      "master_name": "mymaster",
      "sentinels": []
    }
  }
}
SEED

cat > /work/src/config/auth.json << 'SEED'
{
  "auth": {
    "jwt": {
      "secret": "super-secret-jwt-key-2024-prod",
      "algorithm": "HS256",
      "access_token_ttl": 900,
      "refresh_token_ttl": 604800,
      "issuer": "myapp-auth-service",
      "audience": "myapp-api"
    },
    "oauth": {
      "google": {
        "client_id_env": "GOOGLE_CLIENT_ID",
        "client_secret_env": "GOOGLE_CLIENT_SECRET",
        "redirect_uri": "https://api.example.com/auth/google/callback"
      },
      "github": {
        "client_id_env": "GITHUB_CLIENT_ID",
        "client_secret_env": "GITHUB_CLIENT_SECRET",
        "redirect_uri": "https://api.example.com/auth/github/callback"
      }
    },
    "password_policy": {
      "min_length": 12,
      "require_uppercase": true,
      "require_number": true,
      "require_special": true,
      "max_age_days": 90
    },
    "session": {
      "cookie_name": "sid",
      "secure": true,
      "http_only": true,
      "same_site": "strict"
    }
  }
}
SEED

cat > /work/src/config/services.json << 'SEED'
{
  "services": {
    "api_gateway": {
      "host": "0.0.0.0",
      "port": 8080,
      "workers": 4,
      "timeout_ms": 30000
    },
    "auth_service": {
      "host": "auth.internal",
      "port": 8081,
      "health_check": "/health"
    },
    "user_service": {
      "host": "users.internal",
      "port": 8082,
      "health_check": "/health"
    },
    "payment_service": {
      "host": "payments.internal",
      "port": 8083,
      "health_check": "/health",
      "stripe_api_version": "2024-01-01"
    },
    "notification_service": {
      "host": "notifications.internal",
      "port": 8084,
      "health_check": "/health",
      "smtp_host": "smtp.sendgrid.net",
      "smtp_port": 587
    },
    "search_service": {
      "host": "search.internal",
      "port": 8085,
      "elasticsearch_url": "http://es.internal:9200",
      "health_check": "/health"
    }
  }
}
SEED

cat > /work/src/config/logging.json << 'SEED'
{
  "logging": {
    "level": "info",
    "format": "json",
    "outputs": [
      { "type": "stdout" },
      { "type": "file", "path": "/var/log/app/app.log", "rotation": "daily", "max_files": 30 },
      { "type": "syslog", "host": "logs.internal", "port": 514, "facility": "local0" }
    ],
    "correlation_id_header": "X-Request-ID",
    "sensitive_fields": ["password", "token", "secret", "authorization", "cookie"],
    "performance": {
      "slow_query_threshold_ms": 1000,
      "slow_request_threshold_ms": 5000,
      "sample_rate": 0.1
    },
    "error_tracking": {
      "enabled": true,
      "dsn_env": "SENTRY_DSN",
      "environment": "production",
      "traces_sample_rate": 0.05
    }
  }
}
SEED

# ── SERVICE FILES ─────────────────────────────────────────

cat > /work/src/services/auth.py << 'SEED'
"""Authentication service module.
Handles JWT token generation, validation, and OAuth flows.
"""
import hashlib
import hmac
import json
import time
from typing import Any, Optional

# FIXME: Move JWT_SECRET to environment variable — hardcoded secrets are a security risk
JWT_SECRET = "super-secret-jwt-key-2024-prod"
JWT_ALGORITHM = "HS256"
TOKEN_TTL = 900  # 15 minutes

# TODO: Implement refresh token rotation for better security
REFRESH_TTL = 604800  # 7 days


class AuthService:
    """Manages authentication and authorization."""

    def __init__(self, redis_client: Any, db_client: Any):
        self.redis = redis_client
        self.db = db_client
        self._token_cache: dict[str, Any] = {}

    def generate_token(self, user_id: str, roles: list[str]) -> str:
        """Generate a signed JWT token for the given user."""
        payload = {
            "sub": user_id,
            "roles": roles,
            "iat": int(time.time()),
            "exp": int(time.time()) + TOKEN_TTL,
            "iss": "myapp-auth-service",
        }
        # TODO: Replace with proper JWT library (PyJWT)
        header = {"alg": JWT_ALGORITHM, "typ": "JWT"}
        token_data = self._encode_base64(json.dumps(header)) + "." + self._encode_base64(json.dumps(payload))
        signature = hmac.new(JWT_SECRET.encode(), token_data.encode(), hashlib.sha256).hexdigest()
        return token_data + "." + signature

    def validate_token(self, token: str) -> Optional[dict]:
        """Validate and decode a JWT token."""
        if token in self._token_cache:
            cached = self._token_cache[token]
            if cached["exp"] > time.time():
                return cached
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload_str = self._decode_base64(parts[1])
        payload = json.loads(payload_str)
        if payload.get("exp", 0) < time.time():
            return None
        self._token_cache[token] = payload
        return payload

    def revoke_token(self, token: str) -> bool:
        """Add token to the revocation list in Redis."""
        self.redis.setex(f"revoked:{token}", TOKEN_TTL, "1")
        self._token_cache.pop(token, None)
        return True

    @staticmethod
    def _encode_base64(data: str) -> str:
        import base64
        return base64.urlsafe_b64encode(data.encode()).decode().rstrip("=")

    @staticmethod
    def _decode_base64(data: str) -> str:
        import base64
        padding = 4 - len(data) % 4
        return base64.urlsafe_b64decode(data + "=" * padding).decode()
SEED

cat > /work/src/services/users.py << 'SEED'
"""User management service.
Handles user CRUD operations, profile updates, and account management.
"""
import hashlib
import re
from datetime import datetime
from typing import Any, Optional

# FIXME: This hardcoded password is used for the default admin account in development
# It should NEVER appear in production code
ADMIN_DEFAULT_PASSWORD = "admin123!@#"

# TODO: Add email verification flow before activating new accounts
REQUIRE_EMAIL_VERIFICATION = False


class UserService:
    """Manages user accounts and profiles."""

    def __init__(self, db_client: Any, cache_client: Any):
        self.db = db_client
        self.cache = cache_client
        self.password_min_length = 12

    def create_user(self, email: str, password: str, name: str) -> dict:
        """Create a new user account."""
        if not self._validate_email(email):
            raise ValueError(f"Invalid email format: {email}")
        if len(password) < self.password_min_length:
            raise ValueError(f"Password must be at least {self.password_min_length} characters")
        password_hash = self._hash_password(password)
        user = {
            "email": email,
            "name": name,
            "password_hash": password_hash,
            "created_at": datetime.utcnow().isoformat(),
            "is_active": not REQUIRE_EMAIL_VERIFICATION,
            "roles": ["user"],
            "login_attempts": 0,
            "last_login": None,
        }
        user_id = self.db.insert("users", user)
        user["id"] = user_id
        self.cache.set(f"user:{user_id}", user, ttl=3600)
        return user

    def authenticate(self, email: str, password: str) -> Optional[dict]:
        """Authenticate a user by email and password."""
        user = self.db.find_one("users", {"email": email})
        if not user:
            return None
        if user.get("login_attempts", 0) >= 5:
            return None  # Account locked
        if self._verify_password(password, user["password_hash"]):
            self.db.update("users", user["id"], {"login_attempts": 0, "last_login": datetime.utcnow().isoformat()})
            return user
        self.db.update("users", user["id"], {"login_attempts": user.get("login_attempts", 0) + 1})
        return None

    def get_user(self, user_id: str) -> Optional[dict]:
        """Get user by ID, with caching."""
        cached = self.cache.get(f"user:{user_id}")
        if cached:
            return cached
        user = self.db.find_one("users", {"id": user_id})
        if user:
            self.cache.set(f"user:{user_id}", user, ttl=3600)
        return user

    @staticmethod
    def _validate_email(email: str) -> bool:
        return bool(re.match(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$", email))

    @staticmethod
    def _hash_password(password: str) -> str:
        # TODO: Replace with bcrypt or argon2 — SHA256 is not suitable for passwords
        return hashlib.sha256(password.encode()).hexdigest()

    @staticmethod
    def _verify_password(password: str, password_hash: str) -> bool:
        return hashlib.sha256(password.encode()).hexdigest() == password_hash
SEED

cat > /work/src/services/payments.py << 'SEED'
"""Payment processing service.
Handles Stripe integration, invoicing, and subscription management.
"""
from typing import Any, Optional

# TODO: Implement webhook signature verification for Stripe events
STRIPE_WEBHOOK_SECRET_ENV = "STRIPE_WEBHOOK_SECRET"
PAYMENT_SERVICE_PORT = 8083


class PaymentService:
    """Manages payment processing via Stripe."""

    def __init__(self, stripe_client: Any, db_client: Any):
        self.stripe = stripe_client
        self.db = db_client

    def create_charge(self, user_id: str, amount_cents: int, currency: str = "usd") -> dict:
        """Create a payment charge for the given user."""
        user = self.db.find_one("users", {"id": user_id})
        if not user or not user.get("stripe_customer_id"):
            raise ValueError("User has no payment method on file")
        charge = self.stripe.charges.create(
            amount=amount_cents,
            currency=currency,
            customer=user["stripe_customer_id"],
            description=f"Charge for user {user_id}",
        )
        self.db.insert("payments", {
            "user_id": user_id,
            "amount": amount_cents,
            "currency": currency,
            "stripe_charge_id": charge["id"],
            "status": charge["status"],
        })
        return charge

    def refund(self, charge_id: str, reason: str = "requested_by_customer") -> dict:
        """Issue a refund for a given charge."""
        return self.stripe.refunds.create(charge=charge_id, reason=reason)
SEED

cat > /work/src/services/notifications.py << 'SEED'
"""Notification service.
Sends emails, SMS, and push notifications to users.
"""
import smtplib
from email.mime.text import MIMEText
from typing import Any

# FIXME: Remove hardcoded SMTP credentials before deploying to production
SMTP_HOST = "smtp.sendgrid.net"
SMTP_PORT = 587
SMTP_USER = "apikey"

NOTIFICATION_SERVICE_PORT = 8084

# TODO: Add rate limiting for notification sends (max 100 per user per day)
MAX_NOTIFICATIONS_PER_DAY = 100


class NotificationService:
    """Manages multi-channel notifications."""

    def __init__(self, db_client: Any, template_engine: Any):
        self.db = db_client
        self.templates = template_engine

    def send_email(self, to: str, subject: str, body: str) -> bool:
        """Send an email via SMTP."""
        msg = MIMEText(body, "html")
        msg["Subject"] = subject
        msg["From"] = "noreply@example.com"
        msg["To"] = to
        try:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                server.starttls()
                server.login(SMTP_USER, "placeholder")
                server.send_message(msg)
            return True
        except Exception:
            return False

    def send_push(self, user_id: str, title: str, body: str) -> bool:
        """Send a push notification to the user's devices."""
        devices = self.db.find("devices", {"user_id": user_id, "push_enabled": True})
        for device in devices:
            self._send_to_device(device["push_token"], title, body)
        return len(devices) > 0

    @staticmethod
    def _send_to_device(token: str, title: str, body: str) -> None:
        pass  # TODO: Implement FCM/APNs push delivery
SEED

cat > /work/src/services/search.py << 'SEED'
"""Search service module.
Provides full-text search across the application using Elasticsearch.
"""
from typing import Any

SEARCH_SERVICE_PORT = 8085
ES_INDEX_NAME = "myapp_products_v3"

# TODO: Implement search result caching with Redis (TTL=300s)
CACHE_ENABLED = False


class SearchService:
    """Handles search indexing and querying."""

    def __init__(self, es_client: Any, cache_client: Any = None):
        self.es = es_client
        self.cache = cache_client
        self.index = ES_INDEX_NAME

    def search(self, query: str, page: int = 1, size: int = 20) -> dict:
        """Execute a full-text search query."""
        body = {
            "query": {
                "multi_match": {
                    "query": query,
                    "fields": ["title^3", "description^2", "tags", "content"],
                    "type": "best_fields",
                    "fuzziness": "AUTO",
                }
            },
            "from": (page - 1) * size,
            "size": size,
            "highlight": {
                "fields": {"title": {}, "description": {}, "content": {}},
                "pre_tags": ["<mark>"],
                "post_tags": ["</mark>"],
            },
        }
        return self.es.search(index=self.index, body=body)

    def index_document(self, doc_id: str, document: dict) -> bool:
        """Index or update a document."""
        self.es.index(index=self.index, id=doc_id, body=document)
        return True

    def delete_document(self, doc_id: str) -> bool:
        """Remove a document from the index."""
        self.es.delete(index=self.index, id=doc_id, ignore=[404])
        return True
SEED

# ── MIDDLEWARE FILES ──────────────────────────────────────

cat > /work/src/middleware/rate_limiter.py << 'SEED'
"""Rate limiting middleware.
Implements a sliding window rate limiter using Redis.
"""
from typing import Any

# Rate limit: 250 requests per minute per IP
RATE_LIMIT = 250
RATE_WINDOW_SECONDS = 60

# FIXME: The current implementation doesn't handle distributed rate limiting
# across multiple API gateway instances correctly


class RateLimiter:
    """Sliding window rate limiter backed by Redis."""

    def __init__(self, redis_client: Any):
        self.redis = redis_client
        self.limit = RATE_LIMIT
        self.window = RATE_WINDOW_SECONDS

    def is_allowed(self, client_ip: str) -> tuple[bool, dict]:
        """Check if the request is within rate limits."""
        import time
        key = f"ratelimit:{client_ip}"
        now = time.time()
        pipe = self.redis.pipeline()
        pipe.zremrangebyscore(key, 0, now - self.window)
        pipe.zadd(key, {str(now): now})
        pipe.zcard(key)
        pipe.expire(key, self.window)
        _, _, count, _ = pipe.execute()
        headers = {
            "X-RateLimit-Limit": str(self.limit),
            "X-RateLimit-Remaining": str(max(0, self.limit - count)),
            "X-RateLimit-Reset": str(int(now) + self.window),
        }
        return count <= self.limit, headers
SEED

cat > /work/src/middleware/cors.py << 'SEED'
"""CORS middleware configuration.
Controls cross-origin resource sharing for the API.
"""
from typing import Any, Callable

ALLOWED_ORIGIN = "https://app.example.com"
ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-Request-ID"]
MAX_AGE = 86400  # 24 hours

# TODO: Support multiple allowed origins for staging and development environments


class CorsMiddleware:
    """Handles CORS preflight and response headers."""

    def __init__(self, app: Any):
        self.app = app

    def __call__(self, environ: dict, start_response: Callable) -> Any:
        origin = environ.get("HTTP_ORIGIN", "")
        if origin == ALLOWED_ORIGIN:
            headers = [
                ("Access-Control-Allow-Origin", ALLOWED_ORIGIN),
                ("Access-Control-Allow-Methods", ", ".join(ALLOWED_METHODS)),
                ("Access-Control-Allow-Headers", ", ".join(ALLOWED_HEADERS)),
                ("Access-Control-Max-Age", str(MAX_AGE)),
                ("Access-Control-Allow-Credentials", "true"),
            ]
        else:
            headers = []
        if environ["REQUEST_METHOD"] == "OPTIONS":
            start_response("204 No Content", headers)
            return [b""]
        return self.app(environ, start_response)
SEED

cat > /work/src/middleware/logging.py << 'SEED'
"""Request logging middleware.
Logs all incoming requests with timing, status codes, and correlation IDs.
"""
import time
import uuid
from typing import Any, Callable

# TODO: Add structured logging format (JSON) for better log aggregation
LOG_FORMAT = "%(timestamp)s [%(request_id)s] %(method)s %(path)s %(status)s %(duration_ms).2fms"


class LoggingMiddleware:
    """Logs every HTTP request with timing and correlation."""

    def __init__(self, app: Any, logger: Any = None):
        self.app = app
        self.logger = logger

    def __call__(self, environ: dict, start_response: Callable) -> Any:
        request_id = environ.get("HTTP_X_REQUEST_ID", str(uuid.uuid4()))
        environ["REQUEST_ID"] = request_id
        start = time.monotonic()

        def logging_start_response(status: str, headers: list, exc_info: Any = None) -> Any:
            duration = (time.monotonic() - start) * 1000
            if self.logger:
                self.logger.info(LOG_FORMAT, {
                    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "request_id": request_id,
                    "method": environ["REQUEST_METHOD"],
                    "path": environ["PATH_INFO"],
                    "status": status.split(" ")[0],
                    "duration_ms": duration,
                })
            headers.append(("X-Request-ID", request_id))
            return start_response(status, headers, exc_info)

        return self.app(environ, logging_start_response)
SEED

# ── UTILITY FILES ─────────────────────────────────────────

cat > /work/src/utils/crypto.py << 'SEED'
"""Cryptographic utility functions.
Provides hashing, encryption, and token generation utilities.
"""
import hashlib
import hmac
import os
import secrets
from typing import Optional


def generate_api_key(prefix: str = "sk") -> str:
    """Generate a secure random API key."""
    random_bytes = secrets.token_hex(32)
    return f"{prefix}_{random_bytes}"


def unsafe_hash(data: str) -> str:
    """DEPRECATED: Use secure_hash instead. This uses MD5 which is cryptographically broken.
    Kept only for backward compatibility with legacy data migration.
    """
    # FIXME: Remove this function after legacy migration is complete (Q2 2025)
    return hashlib.md5(data.encode()).hexdigest()


def secure_hash(data: str, salt: Optional[str] = None) -> str:
    """Compute a secure SHA-256 hash with optional salt."""
    if salt is None:
        salt = os.urandom(16).hex()
    return f"{salt}:{hashlib.sha256(f'{salt}{data}'.encode()).hexdigest()}"


def constant_time_compare(a: str, b: str) -> bool:
    """Compare two strings in constant time to prevent timing attacks."""
    return hmac.compare_digest(a.encode(), b.encode())


def generate_otp(length: int = 6) -> str:
    """Generate a numeric one-time password."""
    return "".join(str(secrets.randbelow(10)) for _ in range(length))
SEED

cat > /work/src/utils/validators.py << 'SEED'
"""Input validation utilities.
Provides common validation functions used across services.
"""
import re
from typing import Any, Optional

# TODO: Add phone number validation using libphonenumber
PHONE_REGEX = r"^\+?[1-9]\d{1,14}$"
EMAIL_REGEX = r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$"
URL_REGEX = r"^https?://[^\s/$.?#].[^\s]*$"


class ValidationError(Exception):
    """Raised when input validation fails."""
    def __init__(self, field: str, message: str):
        self.field = field
        self.message = message
        super().__init__(f"{field}: {message}")


def validate_email(email: str) -> bool:
    """Validate an email address format."""
    if not email or len(email) > 254:
        return False
    return bool(re.match(EMAIL_REGEX, email))


def validate_phone(phone: str) -> bool:
    """Validate a phone number in E.164 format."""
    return bool(re.match(PHONE_REGEX, phone))


def validate_url(url: str) -> bool:
    """Validate a URL format."""
    return bool(re.match(URL_REGEX, url))


def validate_pagination(page: int, size: int, max_size: int = 100) -> tuple[int, int]:
    """Validate and normalize pagination parameters."""
    page = max(1, page)
    size = max(1, min(size, max_size))
    return page, size


def sanitize_string(value: str, max_length: int = 1000) -> str:
    """Sanitize a string input by stripping whitespace and truncating."""
    return value.strip()[:max_length]
SEED

echo "Setup complete: $(find /work -type f | wc -l) files created"
