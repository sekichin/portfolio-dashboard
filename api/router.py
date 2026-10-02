from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app import Handler


class handler(Handler):
    def restore_request_path(self) -> None:
        parsed = urlsplit(self.path)
        query_items = parse_qsl(parsed.query, keep_blank_values=True)
        route = next((value for key, value in query_items if key == "__path"), "")
        remaining_query = [(key, value) for key, value in query_items if key != "__path"]
        restored_path = f"/api/{route.lstrip('/')}"
        self.path = urlunsplit(("", "", restored_path, urlencode(remaining_query), ""))

    def do_GET(self) -> None:
        self.restore_request_path()
        super().do_GET()

    def do_POST(self) -> None:
        self.restore_request_path()
        super().do_POST()
