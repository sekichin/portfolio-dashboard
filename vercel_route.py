from urllib.parse import urlsplit, urlunsplit

from app import Handler


def fixed_handler(route: str):
    class FixedRouteHandler(Handler):
        def restore_request_path(self) -> None:
            parsed = urlsplit(self.path)
            self.path = urlunsplit(("", "", route, parsed.query, ""))

        def do_GET(self) -> None:
            self.restore_request_path()
            super().do_GET()

        def do_POST(self) -> None:
            self.restore_request_path()
            super().do_POST()

    return FixedRouteHandler
