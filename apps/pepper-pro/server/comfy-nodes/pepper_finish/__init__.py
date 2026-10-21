"""Pepper Pro's own ComfyUI nodes: the film finish (finish.py) as one node.

PepperFilmFinish reads a video file and writes the finished file itself,
frame by frame through the GPU, instead of taking and returning IMAGE
batches: a 4K take as a batch does not fit the 16gb tier's RAM. It is an
output node, so a workflow is LoadVideo -> PepperFilmFinish; its `report`
(timings, HDR light levels, how a take was matched) can go to a PreviewAny,
which Pepper Pro shows as the job's text.
"""
import json
import os
import tempfile
from pathlib import Path

from typing_extensions import override

import comfy.model_management
import comfy.utils
import folder_paths
from comfy_api.latest import ComfyExtension, InputImpl, Types, io, ui

from .finish import LOOKS, OUTPUTS, Settings, finish_video


def _source_file(video, scratch: Path, name: str) -> Path:
    """The file behind a VIDEO: LoadVideo's own path, else (frames made in the
    graph, or a trimmed clip) the video written out once."""
    getter = getattr(video, 'get_stream_source', None)
    source = getter() if getter else None
    trimmed = getattr(video, 'get_active_trim_window', lambda: (0, 0))() != (0, 0)
    if isinstance(source, str) and os.path.isfile(source) and not trimmed:
        return Path(source)
    path = scratch / f'{name}.mp4'
    video.save_to(str(path), format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264)
    return path


class PepperFilmFinish(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id='PepperFilmFinish',
            display_name='Film Finish (Pepper)',
            category='video',
            description='Grade, optics, film grain and an SDR, HDR10 or HLG encode, streamed through the GPU.',
            inputs=[
                io.Video.Input('video'),
                io.Combo.Input('look', options=list(LOOKS), default='strong',
                               tooltip='subtle/medium/strong: the original presenter look. clean, film, film-strong: graded in linear light.'),
                io.Combo.Input('output', options=list(OUTPUTS), default='sdr',
                               tooltip='sdr: Rec.709 H.264. hdr10: BT.2020 PQ HEVC 10-bit with light levels. hlg: BT.2020 HLG HEVC 10-bit.'),
                io.Int.Input('peak', default=1000, min=400, max=4000, tooltip='HDR peak luminance in nits.'),
                io.Combo.Input('expand', options=['curve', 'rtx'], default='curve',
                               tooltip='How HDR highlights are made: the grade\'s own curve, or NVIDIA RTX Video HDR.'),
                io.String.Input('lut', default='', tooltip='A Rec.709 .cube in the input folder to grade with (optional).'),
                io.Float.Input('lut_mix', default=1.0, min=0.0, max=1.0, step=0.01),
                io.Video.Input('match', optional=True, tooltip='A reference take whose skin and exposure this one is matched to.'),
                io.Float.Input('match_strength', default=0.8, min=0.0, max=1.0, step=0.05),
                io.Combo.Input('encoder', options=['cpu', 'fast', 'gpu'], default='cpu',
                               tooltip='cpu: x264 slow / x265 medium. fast: a preset quicker. gpu: NVENC (grain suffers).'),
                io.Int.Input('seed', default=0, min=0, max=2 ** 31 - 1, tooltip='The grain pattern.'),
                io.String.Input('filename_prefix', default='pepper-pro/finish'),
            ],
            outputs=[io.Video.Output('video'), io.String.Output('report')],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, video, look, output, peak, expand, lut, lut_mix, match_strength, encoder, seed, filename_prefix,
                match=None) -> io.NodeOutput:
        device = comfy.model_management.get_torch_device()
        # The picture work needs a GB or two; whatever another recipe left
        # loaded is not needed here.
        comfy.model_management.unload_all_models()
        comfy.model_management.soft_empty_cache()
        if lut.strip() and (os.sep in lut or '/' in lut or lut.startswith('.')):
            raise ValueError(f'LUT {lut!r}: give a file name in the input folder')
        lut_path = Path(folder_paths.get_annotated_filepath(lut)) if lut.strip() else None
        if lut_path is not None and not lut_path.is_file():
            raise FileNotFoundError(f'LUT {lut} is not in the input folder')
        out_dir, filename, counter, subfolder, _ = folder_paths.get_save_image_path(filename_prefix, folder_paths.get_output_directory())
        name = f'{filename}_{counter:05}_.mp4'
        dst = Path(out_dir) / name
        bar = comfy.utils.ProgressBar(100)
        with tempfile.TemporaryDirectory(dir=folder_paths.get_temp_directory()) as scratch:
            scratch = Path(scratch)
            src = _source_file(video, scratch, 'source')
            reference = _source_file(match, scratch, 'match') if match is not None else None
            settings = Settings(look=LOOKS[look], output=output, peak=float(peak), lut=lut_path, lut_mix=lut_mix,
                                expand=expand, seed=seed)
            report = finish_video(src, dst, settings, match=reference, match_strength=match_strength if reference else 0.0,
                                  encoder=encoder, device=device,
                                  progress=lambda done, total: bar.update_absolute(done, max(total, done)),
                                  interrupted=comfy.model_management.throw_exception_if_processing_interrupted)
        text = json.dumps(report)
        print(f'[pepper_finish] {name}: {text}')
        return io.NodeOutput(InputImpl.VideoFromFile(str(dst)), text,
                             ui=ui.PreviewVideo([ui.SavedResult(name, subfolder, io.FolderType.output)]))


class PepperFinishExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [PepperFilmFinish]


async def comfy_entrypoint() -> PepperFinishExtension:
    return PepperFinishExtension()
